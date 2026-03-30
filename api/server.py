"""
AV Triage — Encord API bridge (on-demand upload flow)
Run: python3.11 -m uvicorn api.server:app --port 8001 --reload

Flow: Click "Send to Encord" →
  1. Check if image already exists in Encord dataset (by title prefix)
  2. If not: download annotations from S3 → find best frame → download image → upload to Encord
  3. Create labeling task in project
  4. Return status
"""

import asyncio
import io
import json
import math
import os
import pathlib
import tempfile
import time
from contextlib import asynccontextmanager

import boto3
import numpy as np
import pyarrow.feather as feather
import pyarrow.parquet as pq
import requests as http_requests
from botocore import UNSIGNED
from botocore.config import Config as BotoConfig
from encord import EncordUserClient
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SSH_KEY_PATH = pathlib.Path(
    os.environ.get(
        "ENCORD_SSH_KEY",
        str(pathlib.Path.home() / ".encord" / "encord-av-triage-private-key.ed25519"),
    )
)
DATASET_HASH = os.environ.get("ENCORD_DATASET_HASH", "25abe913-d0eb-4134-be8d-29712a8354b0")
PROJECT_HASH = os.environ.get("ENCORD_PROJECT_HASH", "1b44da5a-ad5d-425c-818b-014be4dbce14")

# Argoverse 2 public S3 bucket
AV2_BUCKET = "argoverse"
AV2_PREFIX = "datasets/av2/sensor/val"

# Waymo LiDAR pipeline
WAYMO_GCS_BASE = "https://storage.googleapis.com/rafael-encord-waymo/waymo_v2"
GCS_BUCKET_NAME = "rafael-encord-waymo"
GCS_LIDAR_FOLDER = "waymo_3d_scenes"
LIDAR_ONTOLOGY_HASH = "1f51b0e3-86c1-4906-8494-a1b3abcae35c"
STORAGE_FOLDER_HASH = "e6b191f4-51bf-4409-bf41-1df05b07360e"
WAYMO_BOX_TYPE_MAP = {1: "Regular Vehicle", 2: "Pedestrian", 3: "Stop Sign", 4: "Bicyclist"}

# AV2 3D pipeline
AV2_3D_FOLDER = "av2_3d_pipeline"
AV2_CATEGORY_MAP = {
    "REGULAR_VEHICLE": "Regular Vehicle",
    "PEDESTRIAN": "Pedestrian",
    "BICYCLIST": "Bicyclist",
    "BUS": "Bus",
    "TRUCK": "Truck",
    "MOTORCYCLIST": "Motorcyclist",
    "BICYCLE": "Bicycle",
    "STOP_SIGN": "Stop Sign",
    "BOLLARD": "Bollard",
    "CONSTRUCTION_CONE": "Construction Cone",
}

# ---------------------------------------------------------------------------
# Singletons & caches
# ---------------------------------------------------------------------------

_s3_client = None
_encord_client = None
_annotations_cache: dict = {}       # scenario_id → DataFrame
_upload_locks: dict = {}            # per-scenario asyncio.Lock
_status_cache: dict | None = None   # cached status response
_status_cache_time: float = 0       # timestamp of last status fetch
STATUS_CACHE_TTL = 30               # seconds


def get_s3():
    """Lazy S3 client — public bucket, no auth required."""
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client(
            "s3",
            config=BotoConfig(signature_version=UNSIGNED),
            region_name="us-east-1",
        )
    return _s3_client


def get_encord():
    """Lazy Encord client."""
    global _encord_client
    if _encord_client is None:
        if not SSH_KEY_PATH.exists():
            raise HTTPException(
                status_code=500,
                detail=f"SSH key not found at {SSH_KEY_PATH}. Set ENCORD_SSH_KEY env var.",
            )
        _encord_client = EncordUserClient.create_with_ssh_private_key(
            ssh_private_key_path=str(SSH_KEY_PATH)
        )
    return _encord_client


def get_lock(scenario_id: str) -> asyncio.Lock:
    """Per-scenario lock to prevent duplicate concurrent uploads."""
    if scenario_id not in _upload_locks:
        _upload_locks[scenario_id] = asyncio.Lock()
    return _upload_locks[scenario_id]


# ---------------------------------------------------------------------------
# S3 helpers
# ---------------------------------------------------------------------------

def download_annotations(scenario_id: str):
    """Download and cache annotations.feather for a scenario."""
    if scenario_id in _annotations_cache:
        return _annotations_cache[scenario_id]

    s3 = get_s3()
    key = f"{AV2_PREFIX}/{scenario_id}/annotations.feather"

    buf = io.BytesIO()
    s3.download_fileobj(AV2_BUCKET, key, buf)
    buf.seek(0)
    df = feather.read_feather(buf)

    _annotations_cache[scenario_id] = df
    return df


def find_best_frame(scenario_id: str) -> dict:
    """
    Find the frame with the most agents.
    Returns: {timestamp_ns, n_agents, n_pedestrians, n_cyclists}
    """
    df = download_annotations(scenario_id)

    # Group by timestamp, count agents
    grouped = df.groupby("timestamp_ns")
    counts = grouped.size().reset_index(name="n_agents")

    # Count pedestrians per timestamp
    if "category" in df.columns:
        ped_counts = (
            df[df["category"] == "PEDESTRIAN"]
            .groupby("timestamp_ns")
            .size()
            .reset_index(name="n_pedestrians")
        )
        counts = counts.merge(ped_counts, on="timestamp_ns", how="left")
        counts["n_pedestrians"] = counts["n_pedestrians"].fillna(0).astype(int)
    else:
        counts["n_pedestrians"] = 0

    # Count cyclists per timestamp
    CYCLIST_CATEGORIES = {"BICYCLIST", "BICYCLE", "WHEELED_RIDER", "MOTORCYCLIST"}
    if "category" in df.columns:
        cyc_counts = (
            df[df["category"].isin(CYCLIST_CATEGORIES)]
            .groupby("timestamp_ns")
            .size()
            .reset_index(name="n_cyclists")
        )
        counts = counts.merge(cyc_counts, on="timestamp_ns", how="left")
        counts["n_cyclists"] = counts["n_cyclists"].fillna(0).astype(int)
    else:
        counts["n_cyclists"] = 0

    # Find timestamp with most agents
    best_idx = counts["n_agents"].idxmax()
    best = counts.iloc[best_idx]

    return {
        "timestamp_ns": int(best["timestamp_ns"]),
        "n_agents": int(best["n_agents"]),
        "n_pedestrians": int(best["n_pedestrians"]),
        "n_cyclists": int(best["n_cyclists"]),
    }


def find_frame_by_index(scenario_id: str, frame_index: int) -> dict:
    """
    Get annotation stats for a specific frame index (0-based).
    Returns same shape as find_best_frame().
    """
    df = download_annotations(scenario_id)
    timestamps = sorted(df["timestamp_ns"].unique())
    idx = max(0, min(frame_index, len(timestamps) - 1))
    ts = timestamps[idx]

    frame_df = df[df["timestamp_ns"] == ts]
    n_agents = len(frame_df)
    n_peds = int((frame_df["category"] == "PEDESTRIAN").sum()) if "category" in frame_df.columns else 0
    CYCLIST_CATEGORIES = {"BICYCLIST", "BICYCLE", "WHEELED_RIDER", "MOTORCYCLIST"}
    n_cyc = int(frame_df["category"].isin(CYCLIST_CATEGORIES).sum()) if "category" in frame_df.columns else 0

    return {
        "timestamp_ns": int(ts),
        "n_agents": n_agents,
        "n_pedestrians": n_peds,
        "n_cyclists": n_cyc,
    }


def find_closest_camera_timestamp(scenario_id: str, target_ts: int) -> int:
    """
    List camera image timestamps from S3 and find closest to target_ts.
    """
    s3 = get_s3()
    prefix = f"{AV2_PREFIX}/{scenario_id}/sensors/cameras/ring_front_center/"

    # Paginate in case there are many images
    timestamps = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=AV2_BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []):
            filename = obj["Key"].split("/")[-1]
            if filename.endswith(".jpg"):
                try:
                    ts = int(filename.replace(".jpg", ""))
                    timestamps.append(ts)
                except ValueError:
                    continue

    if not timestamps:
        raise HTTPException(
            status_code=404,
            detail=f"No camera images found for scenario {scenario_id}",
        )

    return min(timestamps, key=lambda t: abs(t - target_ts))


def download_camera_image(scenario_id: str, timestamp_ns: int) -> bytes:
    """Download a camera image from S3, return raw JPEG bytes."""
    s3 = get_s3()
    key = f"{AV2_PREFIX}/{scenario_id}/sensors/cameras/ring_front_center/{timestamp_ns}.jpg"

    buf = io.BytesIO()
    s3.download_fileobj(AV2_BUCKET, key, buf)
    buf.seek(0)
    return buf.read()


# ---------------------------------------------------------------------------
# Encord helpers
# ---------------------------------------------------------------------------

def find_existing_data_row(dataset, scenario_prefix: str):
    """Search dataset for a row whose title starts with scenario_prefix."""
    for row in dataset.list_data_rows():
        if row.title.startswith(scenario_prefix):
            return row
    return None


def upload_image_to_encord(dataset, image_bytes: bytes, title: str) -> str:
    """
    Upload an image to the Encord dataset.
    Returns the data unit UID.
    """
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp.write(image_bytes)
        tmp_path = tmp.name

    try:
        result = dataset.upload_image(file_path=tmp_path, title=title, folder=STORAGE_FOLDER_HASH)

        # upload_image return type varies by SDK version — handle gracefully
        if isinstance(result, str):
            return result
        if hasattr(result, "data_hash"):
            return result.data_hash
        if isinstance(result, dict) and "data_hash" in result:
            return result["data_hash"]

        # Fallback: search for the row we just uploaded
        row = find_existing_data_row(dataset, title)
        if row:
            return row.uid
        raise Exception(f"Upload succeeded but could not determine UID for '{title}'")
    finally:
        os.unlink(tmp_path)


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    if not SSH_KEY_PATH.exists():
        print(f"[encord] WARNING: SSH key not found at {SSH_KEY_PATH}")
    else:
        print(f"[encord] SSH key found: {SSH_KEY_PATH}")
    print(f"[encord] Project: {PROJECT_HASH}")
    print(f"[encord] Dataset: {DATASET_HASH}")
    yield


app = FastAPI(title="AV Triage API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:4173",
        "http://127.0.0.1:5173",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class SendRequest(BaseModel):
    scenario_id: str
    dataset: str = "argoverse2"
    frame_index: int | None = None


@app.get("/api/encord/health")
async def health():
    return {"status": "ok", "ssh_key_found": SSH_KEY_PATH.exists()}


@app.post("/api/encord/send")
async def send_to_encord(req: SendRequest):
    """
    On-demand upload flow:
    1. Check if image already in dataset
    2. If not → fetch best frame → upload → task
    3. Return status
    """
    scenario_id = req.scenario_id
    dataset = req.dataset

    if dataset in ("waymo_v2", "waymo_perception"):
        scenario_prefix = f"waymo_{scenario_id[:8]}"
    elif dataset == "nuscenes_mini":
        scenario_prefix = f"ns_{scenario_id[:8]}"
    else:
        scenario_prefix = f"av2_{scenario_id[:8]}"

    # Per-scenario lock prevents duplicate uploads from rapid clicks
    lock = get_lock(scenario_id)
    async with lock:
        result = await asyncio.to_thread(
            _send_to_encord_sync, scenario_id, scenario_prefix, dataset, req.frame_index
        )
        return result


def _send_to_encord_sync(scenario_id: str, scenario_prefix: str, dataset: str = "argoverse2", frame_index: int | None = None) -> dict:
    """Synchronous implementation — runs in thread pool."""
    try:
        if dataset in ("waymo_v2", "waymo_perception"):
            scenario_prefix = f"waymo_{scenario_id[:8]}"
            return _send_waymo_lidar_to_encord(scenario_id, scenario_prefix, frame_index=frame_index)

        if dataset == "nuscenes_mini":
            return _send_nuscenes_to_encord(scenario_id, scenario_prefix, frame_index=frame_index)

        # ── AV2: try full 3D pipeline, fall back to image-only ──
        try:
            return _send_av2_3d_to_encord(scenario_id, scenario_prefix, frame_index=frame_index)
        except Exception as e3d:
            print(f"[av2] 3D pipeline failed, falling back to image-only: {e3d}")

        # Fallback: image-only upload
        client = get_encord()
        dataset_obj = client.get_dataset(DATASET_HASH)
        project = client.get_project(PROJECT_HASH)

        existing_row = find_existing_data_row(dataset_obj, scenario_prefix)
        if existing_row:
            uid = existing_row.uid
            try:
                project.create_label_row(uid=uid)
                return {"success": True, "status": "task_created", "already_existed": False, "uid": uid, "title": existing_row.title}
            except Exception as inner:
                if _is_duplicate_error(inner):
                    return {"success": True, "status": "already_existed", "already_existed": True, "uid": uid, "title": existing_row.title}
                raise

        if frame_index is not None:
            best = find_frame_by_index(scenario_id, frame_index)
        else:
            best = find_best_frame(scenario_id)

        camera_ts = find_closest_camera_timestamp(scenario_id, best["timestamp_ns"])
        image_bytes = download_camera_image(scenario_id, camera_ts)
        title = f"{scenario_prefix}_{best['n_agents']}agents_{best['n_pedestrians']}peds"
        uid = upload_image_to_encord(dataset_obj, image_bytes, title)
        try:
            project.create_label_row(uid=uid)
        except Exception as inner:
            if not _is_duplicate_error(inner):
                raise

        return {"success": True, "status": "uploaded_and_created", "already_existed": False, "uid": uid, "title": title, "best_frame": best}

    except HTTPException:
        raise
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def _is_duplicate_error(exc: Exception) -> bool:
    """Check if an Encord exception means the resource already exists."""
    msg = str(exc).lower()
    return any(kw in msg for kw in ("already", "exists", "duplicate", "conflict"))


# ---------------------------------------------------------------------------
# Shared 3D pipeline helpers
# ---------------------------------------------------------------------------


def quat_to_euler(qw, qx, qy, qz):
    """Quaternion → Euler angles (roll, pitch, yaw)."""
    sinr_cosp = 2 * (qw * qx + qy * qz)
    cosr_cosp = 1 - 2 * (qx * qx + qy * qy)
    roll = math.atan2(sinr_cosp, cosr_cosp)
    sinp = 2 * (qw * qy - qz * qx)
    pitch = math.asin(max(-1, min(1, sinp)))
    siny_cosp = 2 * (qw * qz + qx * qy)
    cosy_cosp = 1 - 2 * (qy * qy + qz * qz)
    yaw = math.atan2(siny_cosp, cosy_cosp)
    return roll, pitch, yaw


def create_3stream_scene(client, title, ply_gcs_uri, cam_gcs_uri, cam_w, cam_h, cam_fx, cam_fy, cam_ox, cam_oy):
    """Create a 3-stream Encord scene (lidar + camera_params + image) and link to dataset."""
    scene_manifest = {
        "scenes": [{
            "title": title,
            "scene": {
                "lidar": {
                    "type": "point_cloud",
                    "events": [{"uri": ply_gcs_uri}],
                },
                "front_camera_params": {
                    "type": "camera_parameters",
                    "events": [{
                        "timestamp": 1,
                        "widthPx": cam_w,
                        "heightPx": cam_h,
                        "intrinsics": {
                            "type": "simple",
                            "fx": cam_fx, "fy": cam_fy,
                            "ox": cam_ox, "oy": cam_oy,
                        },
                    }],
                },
                "front_camera": {
                    "type": "image",
                    "camera": "front_camera_params",
                    "events": [{"uri": cam_gcs_uri}],
                },
            },
        }],
        "skipDuplicateUrls": True,
    }
    scene_json_path = tempfile.mktemp(suffix=".json")
    with open(scene_json_path, "w") as f:
        json.dump(scene_manifest, f)

    folder = client.get_storage_folder(STORAGE_FOLDER_HASH)
    integrations = client.get_cloud_integrations()
    gcp_integration = next(
        (i for i in integrations if any(kw in i.title.lower() for kw in ("gcp", "waymo", "rafael", "google"))),
        None,
    )
    if not gcp_integration:
        raise Exception("No GCP integration found in Encord")

    job = folder.add_private_data_to_folder_start(gcp_integration.id, scene_json_path)
    folder.add_private_data_to_folder_get_result(job)
    os.unlink(scene_json_path)

    # Link scene from storage folder to dataset
    time.sleep(3)
    dataset_obj = client.get_dataset(DATASET_HASH)
    for item in folder.list_items():
        if item.name == title:
            dataset_obj.link_items(item_uuids=[str(item.uuid)])
            print(f"[scene] Linked {title} to dataset")
            break

    # Wait for scene to appear in project, create label row
    time.sleep(3)
    project = client.get_project(PROJECT_HASH)
    task_created = False
    for lr in project.list_label_rows_v2():
        if lr.data_title == title:
            try:
                project.create_label_row(uid=lr.data_hash)
                task_created = True
            except Exception as e:
                if _is_duplicate_error(e):
                    task_created = True
            break
    return task_created


def create_lidar_only_scene(client, title, ply_gcs_uri):
    """Create a lidar-only Encord scene and link to dataset."""
    scene_manifest = {
        "scenes": [{
            "title": title,
            "scene": {
                "lidar": {
                    "type": "point_cloud",
                    "events": [{"uri": ply_gcs_uri}],
                },
            },
        }],
        "skipDuplicateUrls": True,
    }
    scene_json_path = tempfile.mktemp(suffix=".json")
    with open(scene_json_path, "w") as f:
        json.dump(scene_manifest, f)

    folder = client.get_storage_folder(STORAGE_FOLDER_HASH)
    integrations = client.get_cloud_integrations()
    gcp_integration = next(
        (i for i in integrations if any(kw in i.title.lower() for kw in ("gcp", "waymo", "rafael", "google"))),
        None,
    )
    if not gcp_integration:
        raise Exception("No GCP integration found in Encord")

    job = folder.add_private_data_to_folder_start(gcp_integration.id, scene_json_path)
    folder.add_private_data_to_folder_get_result(job)
    os.unlink(scene_json_path)

    time.sleep(3)
    dataset_obj = client.get_dataset(DATASET_HASH)
    for item in folder.list_items():
        if item.name == title:
            dataset_obj.link_items(item_uuids=[str(item.uuid)])
            print(f"[scene] Linked {title} to dataset")
            break

    time.sleep(3)
    project = client.get_project(PROJECT_HASH)
    task_created = False
    for lr in project.list_label_rows_v2():
        if lr.data_title == title:
            try:
                project.create_label_row(uid=lr.data_hash)
                task_created = True
            except Exception as e:
                if _is_duplicate_error(e):
                    task_created = True
            break
    return task_created


# ---------------------------------------------------------------------------
# AV2 3D pipeline
# ---------------------------------------------------------------------------


def av2_lidar_to_ply(scenario_id: str, timestamp_ns: int) -> tuple[bytes, int]:
    """Download AV2 LiDAR feather from S3, convert to PLY. Returns (ply_bytes, n_points)."""
    import open3d as o3d

    s3 = get_s3()
    key = f"{AV2_PREFIX}/{scenario_id}/sensors/lidar/{timestamp_ns}.feather"
    buf = io.BytesIO()
    s3.download_fileobj(AV2_BUCKET, key, buf)
    buf.seek(0)
    lidar_df = feather.read_feather(buf)

    points = lidar_df[["x", "y", "z"]].values.astype(np.float64)

    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(points)

    if "intensity" in lidar_df.columns:
        intensity = lidar_df["intensity"].values.astype(np.float64)
        norm = (intensity - intensity.min()) / (intensity.max() - intensity.min() + 1e-8)
        colors = np.stack([norm, norm, norm], axis=1)
        pcd.colors = o3d.utility.Vector3dVector(colors)

    ply_path = tempfile.mktemp(suffix=".ply")
    o3d.io.write_point_cloud(ply_path, pcd, write_ascii=True)
    with open(ply_path, "rb") as f:
        ply_bytes = f.read()
    os.unlink(ply_path)
    return ply_bytes, len(points)


def write_av2_cuboid_predictions(client, project_hash, ontology_hash, scene_title, annotations_df, timestamp_ns):
    """Write AV2 3D bounding boxes as Encord cuboid labels."""
    from encord.objects.coordinates import CuboidCoordinates

    frame_df = annotations_df[annotations_df["timestamp_ns"] == timestamp_ns]
    if frame_df.empty:
        return 0

    ontology = client.get_ontology(ontology_hash)
    project = client.get_project(project_hash)

    target_row = None
    for lr in project.list_label_rows_v2():
        if lr.data_title == scene_title:
            target_row = lr
            break
    if not target_row:
        return 0

    target_row.initialise_labels()
    n = 0
    for _, box in frame_df.iterrows():
        category = str(box.get("category", ""))
        ont_name = AV2_CATEGORY_MAP.get(category)
        if not ont_name:
            continue
        try:
            ont_obj = ontology.structure.get_child_by_title(ont_name)
        except Exception:
            continue

        roll, pitch, yaw = quat_to_euler(
            float(box["qw"]), float(box["qx"]), float(box["qy"]), float(box["qz"])
        )

        instance = ont_obj.create_instance()
        coords = CuboidCoordinates(
            position=(float(box["tx"]), float(box["ty"]), float(box["tz"])),
            orientation=(roll, pitch, yaw),
            size=(float(box["length"]), float(box["width"]), float(box["height"])),
        )
        instance.set_for_frames(coords, frames=0, confidence=0.95, manual_annotation=False)
        target_row.add_object_instance(instance)
        n += 1

    target_row.save()
    return n


def _send_av2_3d_to_encord(scenario_id: str, scenario_prefix: str, frame_index: int | None = None) -> dict:
    """Full AV2 3D pipeline: annotations → LiDAR PLY → camera → GCS → Encord scene → cuboid predictions."""
    import traceback

    client = get_encord()

    # ── Step 1: Find target frame ──
    if frame_index is not None:
        best = find_frame_by_index(scenario_id, frame_index)
    else:
        best = find_best_frame(scenario_id)
    timestamp_ns = best["timestamp_ns"]

    fi_label = f"f{frame_index}" if frame_index is not None else "best"
    title = f"{scenario_prefix}_{fi_label}_{best['n_agents']}ag"

    # Check if already exists
    project = client.get_project(PROJECT_HASH)
    for lr in project.list_label_rows_v2():
        if lr.data_title == title:
            return {
                "success": True,
                "status": "already_existed",
                "already_existed": True,
                "title": title,
            }

    # ── Step 2: Download LiDAR and convert to PLY ──
    print(f"[av2-3d] Downloading LiDAR for ts={timestamp_ns}...")
    ply_bytes, n_points = av2_lidar_to_ply(scenario_id, timestamp_ns)
    print(f"[av2-3d] PLY: {n_points} points")

    # ── Step 3: Upload PLY to GCS ──
    ply_gcs_path = f"{AV2_3D_FOLDER}/{title}.ply"
    ply_gcs_uri = upload_to_gcs(ply_bytes, ply_gcs_path)

    # ── Step 4: Download camera image from S3 ──
    camera_ts = find_closest_camera_timestamp(scenario_id, timestamp_ns)
    image_bytes = download_camera_image(scenario_id, camera_ts)

    # ── Step 5: Upload camera image to GCS ──
    cam_gcs_path = f"{AV2_3D_FOLDER}/{title}_front.jpg"
    cam_gcs_uri = upload_to_gcs(image_bytes, cam_gcs_path)

    # ── Step 6: Create 3-stream Encord scene ──
    print(f"[av2-3d] Creating 3-stream scene...")
    task_created = create_3stream_scene(
        client, title, ply_gcs_uri, cam_gcs_uri,
        cam_w=1550, cam_h=2048, cam_fx=1000.0, cam_fy=1000.0, cam_ox=775.0, cam_oy=1024.0,
    )

    # ── Step 7: Write cuboid predictions ──
    n_cuboids = 0
    try:
        annotations_df = download_annotations(scenario_id)
        n_cuboids = write_av2_cuboid_predictions(
            client, PROJECT_HASH, LIDAR_ONTOLOGY_HASH, title, annotations_df, timestamp_ns
        )
        print(f"[av2-3d] {n_cuboids} cuboids written")
    except Exception as e:
        print(f"[av2-3d] Cuboid writing failed: {e}")
        traceback.print_exc()

    return {
        "success": True,
        "status": "uploaded_and_created",
        "already_existed": False,
        "title": title,
        "n_points": n_points,
        "n_cuboids": n_cuboids,
        "task_created": task_created,
        "best_frame": best,
    }


# ---------------------------------------------------------------------------
# nuScenes → Encord pipeline (full 3D)
# ---------------------------------------------------------------------------

NUSCENES_3D_FOLDER = "nuscenes_3d_pipeline"
NUSCENES_ENCORD_CATEGORY_MAP = {
    "vehicle.car": "Regular Vehicle",
    "vehicle.truck": "Truck",
    "vehicle.bus.bendy": "Bus",
    "vehicle.bus.rigid": "Bus",
    "vehicle.construction": "Regular Vehicle",
    "vehicle.emergency.ambulance": "Regular Vehicle",
    "vehicle.emergency.police": "Regular Vehicle",
    "vehicle.trailer": "Truck",
    "human.pedestrian.adult": "Pedestrian",
    "human.pedestrian.child": "Pedestrian",
    "human.pedestrian.construction_worker": "Pedestrian",
    "human.pedestrian.personal_mobility": "Pedestrian",
    "human.pedestrian.police_officer": "Pedestrian",
    "human.pedestrian.stroller": "Pedestrian",
    "human.pedestrian.wheelchair": "Pedestrian",
    "vehicle.motorcycle": "Motorcyclist",
    "vehicle.bicycle": "Bicycle",
    "movable_object.barrier": "Bollard",
    "movable_object.trafficcone": "Construction Cone",
    "static_object.bicycle_rack": "Bicycle",
}


def _resolve_nuscenes_base_url(scenario_id: str) -> str:
    """Look up base_url for a nuScenes scenario from the scenario index."""
    index_path = pathlib.Path(__file__).parent.parent / "src" / "data" / "scenario_index.json"
    if index_path.exists():
        with open(index_path) as f:
            for entry in json.load(f):
                if entry.get("id") == scenario_id and entry.get("dataset") == "nuscenes_mini":
                    return entry.get("base_url", "")
    return ""


def _nuscenes_quat_to_matrix(rotation, translation):
    """Convert nuScenes quaternion [w,x,y,z] + translation to 4x4 matrix."""
    w, x, y, z = rotation
    tx, ty, tz = translation
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), tx],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), ty],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), tz],
        [0, 0, 0, 1],
    ])


def _load_nuscenes_metadata(base_url: str):
    """Download and parse nuScenes metadata JSONs. Returns (meta_dict, detected_split)."""
    detected_split = None
    for split in ("v1.0-mini", "v1.0-trainval", "v1.0-test"):
        try:
            resp = http_requests.head(f"{base_url}{split}/scene.json", timeout=10)
            if resp.status_code == 200:
                detected_split = split
                break
        except Exception:
            continue
    if not detected_split:
        raise Exception("Could not detect nuScenes split")

    meta_base = f"{base_url}{detected_split}/"
    meta = {}
    for name in ("scene", "sample", "sample_data", "sample_annotation",
                 "ego_pose", "calibrated_sensor", "sensor", "instance", "category"):
        print(f"[nuscenes] Fetching {name}.json...")
        resp = http_requests.get(f"{meta_base}{name}.json", timeout=60)
        resp.raise_for_status()
        meta[name] = resp.json()

    return meta, detected_split


def _nuscenes_resolve_frame(meta, scenario_id, frame_index):
    """Find target scene and walk to the frame. Returns (target_sample, ordered_samples, scene)."""
    sample_by_token = {s["token"]: s for s in meta["sample"]}
    scene = None
    for sc in meta["scene"]:
        if sc.get("name") == scenario_id or sc.get("token") == scenario_id:
            scene = sc
            break
    if not scene:
        raise Exception(f"Scene '{scenario_id}' not found")

    ordered_samples = []
    cur = scene.get("first_sample_token")
    while cur and cur in sample_by_token:
        ordered_samples.append(sample_by_token[cur])
        cur = sample_by_token[cur].get("next", "")

    if not ordered_samples:
        raise Exception(f"No samples found for scene '{scenario_id}'")

    fi = frame_index if frame_index is not None else 0
    fi = max(0, min(fi, len(ordered_samples) - 1))
    return ordered_samples[fi], ordered_samples, scene, fi


def _nuscenes_find_sensor_sd(meta, sample_token, channel_prefix, exclude_prefixes=None):
    """Find a keyframe sample_data entry for a given sensor channel."""
    for sd in meta["sample_data"]:
        if sd.get("sample_token") != sample_token or not sd.get("is_key_frame", False):
            continue
        fn = sd.get("filename", "")
        if channel_prefix in fn:
            if exclude_prefixes and any(ex in fn for ex in exclude_prefixes):
                continue
            return sd
    return None


def _send_nuscenes_to_encord(scenario_id: str, scenario_prefix: str, frame_index: int | None = None) -> dict:
    """Full nuScenes 3D pipeline: LiDAR PLY + camera + cuboid predictions."""
    import traceback

    try:
        return _send_nuscenes_3d(scenario_id, scenario_prefix, frame_index)
    except Exception as e3d:
        print(f"[nuscenes] 3D pipeline failed, falling back to image-only: {e3d}")
        traceback.print_exc()

    # Fallback: image-only upload
    base_url = _resolve_nuscenes_base_url(scenario_id)
    if not base_url:
        raise HTTPException(status_code=400, detail=f"No base_url found for nuScenes scenario {scenario_id}")

    client = get_encord()
    dataset_obj = client.get_dataset(DATASET_HASH)
    project = client.get_project(PROJECT_HASH)
    fi_label = f"f{frame_index}" if frame_index is not None else "f0"
    title = f"{scenario_prefix}_{fi_label}"

    existing_row = find_existing_data_row(dataset_obj, scenario_prefix)
    if existing_row:
        uid = existing_row.uid
        try:
            project.create_label_row(uid=uid)
            return {"success": True, "status": "task_created", "already_existed": False, "uid": uid, "title": existing_row.title}
        except Exception as inner:
            if _is_duplicate_error(inner):
                return {"success": True, "status": "already_existed", "already_existed": True, "uid": uid, "title": existing_row.title}
            raise

    # Download front camera image
    meta, _ = _load_nuscenes_metadata(base_url)
    target_sample, _, _, fi = _nuscenes_resolve_frame(meta, scenario_id, frame_index)
    cam_sd = _nuscenes_find_sensor_sd(meta, target_sample["token"], "CAM_FRONT/", ["CAM_FRONT_LEFT", "CAM_FRONT_RIGHT"])
    if not cam_sd:
        raise HTTPException(status_code=404, detail="No CAM_FRONT data found")
    img_resp = http_requests.get(f"{base_url}{cam_sd['filename']}", timeout=30)
    img_resp.raise_for_status()

    uid = upload_image_to_encord(dataset_obj, img_resp.content, title)
    try:
        project.create_label_row(uid=uid)
    except Exception as inner:
        if not _is_duplicate_error(inner):
            raise
    return {"success": True, "status": "uploaded_and_created", "already_existed": False, "uid": uid, "title": title}


def _send_nuscenes_3d(scenario_id: str, scenario_prefix: str, frame_index: int | None = None) -> dict:
    """Full nuScenes 3D pipeline."""
    import open3d as o3d
    import traceback

    client = get_encord()
    fi_label = f"f{frame_index}" if frame_index is not None else "f0"
    title = f"{scenario_prefix}_{fi_label}"

    # Check if already exists
    project = client.get_project(PROJECT_HASH)
    for lr in project.list_label_rows_v2():
        if lr.data_title == title:
            return {"success": True, "status": "already_existed", "already_existed": True, "title": title}

    base_url = _resolve_nuscenes_base_url(scenario_id)
    if not base_url:
        raise Exception(f"No base_url for {scenario_id}")

    # ── Step 1: Download metadata ──
    meta, _ = _load_nuscenes_metadata(base_url)
    target_sample, ordered_samples, scene, fi = _nuscenes_resolve_frame(meta, scenario_id, frame_index)

    # ── Step 2: Download LiDAR bin and convert to PLY ──
    lidar_sd = _nuscenes_find_sensor_sd(meta, target_sample["token"], "LIDAR_TOP")
    if not lidar_sd:
        raise Exception(f"No LIDAR_TOP data for frame {fi}")

    print(f"[nuscenes] Downloading LiDAR: {lidar_sd['filename']}...")
    lidar_resp = http_requests.get(f"{base_url}{lidar_sd['filename']}", timeout=60)
    lidar_resp.raise_for_status()

    pts_raw = np.frombuffer(lidar_resp.content, dtype=np.float32).reshape(-1, 5)
    points = pts_raw[:, 0:3].astype(np.float64)
    intensity = pts_raw[:, 3].astype(np.float64)

    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(points)
    norm = (intensity - intensity.min()) / (intensity.max() - intensity.min() + 1e-8)
    colors_arr = np.stack([norm, norm, norm], axis=1)
    pcd.colors = o3d.utility.Vector3dVector(colors_arr)

    ply_path = tempfile.mktemp(suffix=".ply")
    o3d.io.write_point_cloud(ply_path, pcd, write_ascii=True)
    with open(ply_path, "rb") as f:
        ply_bytes = f.read()
    os.unlink(ply_path)
    n_points = len(points)
    print(f"[nuscenes] PLY: {n_points} points")

    # ── Step 3: Upload PLY to GCS ──
    ply_gcs_uri = upload_to_gcs(ply_bytes, f"{NUSCENES_3D_FOLDER}/{title}.ply")

    # ── Step 4: Download front camera image ──
    cam_sd = _nuscenes_find_sensor_sd(meta, target_sample["token"], "CAM_FRONT/", ["CAM_FRONT_LEFT", "CAM_FRONT_RIGHT"])
    if not cam_sd:
        raise Exception(f"No CAM_FRONT data for frame {fi}")

    print(f"[nuscenes] Downloading CAM_FRONT: {cam_sd['filename']}...")
    cam_resp = http_requests.get(f"{base_url}{cam_sd['filename']}", timeout=30)
    cam_resp.raise_for_status()

    cam_gcs_uri = upload_to_gcs(cam_resp.content, f"{NUSCENES_3D_FOLDER}/{title}_front.jpg")

    # ── Step 5: Get camera intrinsics from calibrated_sensor ──
    cam_w, cam_h = 1600, 900
    cam_fx, cam_fy, cam_ox, cam_oy = 1000.0, 1000.0, 800.0, 450.0
    cs_token = cam_sd.get("calibrated_sensor_token")
    if cs_token:
        for cs in meta["calibrated_sensor"]:
            if cs["token"] == cs_token:
                intrinsic = cs.get("camera_intrinsic")
                if intrinsic and len(intrinsic) >= 2:
                    cam_fx = intrinsic[0][0]
                    cam_fy = intrinsic[1][1]
                    cam_ox = intrinsic[0][2]
                    cam_oy = intrinsic[1][2]
                break

    # ── Step 6: Create 3-stream Encord scene ──
    print(f"[nuscenes] Creating 3-stream scene...")
    task_created = create_3stream_scene(
        client, title, ply_gcs_uri, cam_gcs_uri,
        cam_w=cam_w, cam_h=cam_h, cam_fx=cam_fx, cam_fy=cam_fy, cam_ox=cam_ox, cam_oy=cam_oy,
    )

    # ── Step 7: Write cuboid predictions ──
    n_cuboids = 0
    try:
        n_cuboids = _write_nuscenes_cuboids(client, meta, target_sample, lidar_sd, title)
        print(f"[nuscenes] {n_cuboids} cuboids written")
    except Exception as e:
        print(f"[nuscenes] Cuboid writing failed: {e}")
        traceback.print_exc()

    return {
        "success": True,
        "status": "uploaded_and_created",
        "already_existed": False,
        "title": title,
        "n_points": n_points,
        "n_cuboids": n_cuboids,
        "task_created": task_created,
    }


def _write_nuscenes_cuboids(client, meta, target_sample, lidar_sd, scene_title) -> int:
    """Write nuScenes 3D bounding boxes as Encord cuboid labels."""
    from encord.objects.coordinates import CuboidCoordinates

    # Build lookup maps
    instance_by_token = {i["token"]: i for i in meta["instance"]}
    category_by_token = {c["token"]: c for c in meta["category"]}
    ego_pose_by_token = {ep["token"]: ep for ep in meta["ego_pose"]}

    # Get ego pose for this frame's LIDAR_TOP
    ego_pose = ego_pose_by_token.get(lidar_sd.get("ego_pose_token", ""))
    if not ego_pose:
        return 0
    ego_matrix = _nuscenes_quat_to_matrix(ego_pose["rotation"], ego_pose["translation"])
    inv_ego = np.linalg.inv(ego_matrix)

    # Get annotations for the target sample
    annotations = [a for a in meta["sample_annotation"] if a["sample_token"] == target_sample["token"]]
    if not annotations:
        return 0

    ontology = client.get_ontology(LIDAR_ONTOLOGY_HASH)
    project = client.get_project(PROJECT_HASH)

    target_row = None
    for lr in project.list_label_rows_v2():
        if lr.data_title == scene_title:
            target_row = lr
            break
    if not target_row:
        return 0

    target_row.initialise_labels()
    n = 0
    for ann in annotations:
        # Resolve category name
        inst = instance_by_token.get(ann.get("instance_token", ""))
        cat_token = inst.get("category_token", "") if inst else ""
        cat = category_by_token.get(cat_token)
        cat_name = cat.get("name", "") if cat else ""
        ont_name = NUSCENES_ENCORD_CATEGORY_MAP.get(cat_name)
        if not ont_name:
            continue

        try:
            ont_obj = ontology.structure.get_child_by_title(ont_name)
        except Exception:
            continue

        # Transform box from global to vehicle frame
        box_matrix = _nuscenes_quat_to_matrix(ann["rotation"], ann["translation"])
        box_vehicle = inv_ego @ box_matrix
        cx, cy, cz = float(box_vehicle[0, 3]), float(box_vehicle[1, 3]), float(box_vehicle[2, 3])
        heading = float(math.atan2(box_vehicle[1, 0], box_vehicle[0, 0]))

        # nuScenes size is [width, length, height] → Encord size=(length, width, height)
        width, length, height = ann["size"]

        instance = ont_obj.create_instance()
        coords = CuboidCoordinates(
            position=(cx, cy, cz),
            orientation=(0.0, 0.0, heading),
            size=(float(length), float(width), float(height)),
        )
        instance.set_for_frames(coords, frames=0, confidence=0.95, manual_annotation=False)
        target_row.add_object_instance(instance)
        n += 1

    target_row.save()
    return n


# ---------------------------------------------------------------------------
# Waymo LiDAR → Encord pipeline
# ---------------------------------------------------------------------------


def compute_inclinations(height, beam_values, beam_min, beam_max):
    if beam_values is not None and len(beam_values) == height:
        return np.array(beam_values[::-1], dtype=np.float64)
    t = np.linspace(0, 1, height)
    return beam_max * (1 - t) + beam_min * t


def compute_azimuths(width, az_correction):
    col = np.arange(width)
    ratio = (width - col - 0.5) / width
    return (ratio * 2 - 1) * np.pi - az_correction


def convert_range_image_to_xyz(range_values, shape, extrinsic, beam_values, beam_min, beam_max):
    height, width, channels = shape
    data = np.array(range_values, dtype=np.float64).reshape(height, width, channels)
    ranges = data[:, :, 0]
    intensities_raw = data[:, :, 1]

    inclinations = compute_inclinations(height, beam_values, beam_min, beam_max)
    az_correction = math.atan2(extrinsic[4], extrinsic[0])
    azimuths = compute_azimuths(width, az_correction)

    cos_inc = np.cos(inclinations)[:, np.newaxis]
    sin_inc = np.sin(inclinations)[:, np.newaxis]
    cos_az = np.cos(azimuths)[np.newaxis, :]
    sin_az = np.sin(azimuths)[np.newaxis, :]

    x_s = ranges * cos_inc * cos_az
    y_s = ranges * cos_inc * sin_az
    z_s = ranges * sin_inc

    valid = ranges > 0
    x_v, y_v, z_v = x_s[valid], y_s[valid], z_s[valid]
    intensities = intensities_raw[valid]

    e = np.array(extrinsic).reshape(4, 4)
    sensor_pts = np.stack([x_v, y_v, z_v, np.ones_like(x_v)], axis=1)
    vehicle_pts = (e @ sensor_pts.T).T[:, :3]
    return vehicle_pts, intensities


def waymo_parquet_to_ply(lidar_bytes, calib_bytes, frame_index=None):
    import open3d as o3d

    lidar_df = pq.read_table(io.BytesIO(lidar_bytes)).to_pandas()
    calib_df = pq.read_table(io.BytesIO(calib_bytes)).to_pandas()

    timestamps = sorted(lidar_df["key.frame_timestamp_micros"].unique())
    if not timestamps:
        raise ValueError("No frames found")
    if frame_index is None:
        frame_index = len(timestamps) // 2
    target_ts = timestamps[min(frame_index, len(timestamps) - 1)]

    frame_rows = lidar_df[lidar_df["key.frame_timestamp_micros"] == target_ts]

    calibrations = {}
    for _, row in calib_df.iterrows():
        calibrations[row["key.laser_name"]] = {
            "extrinsic": row["[LiDARCalibrationComponent].extrinsic.transform"],
            "beam_values": row.get("[LiDARCalibrationComponent].beam_inclination.values"),
            "beam_min": row["[LiDARCalibrationComponent].beam_inclination.min"],
            "beam_max": row["[LiDARCalibrationComponent].beam_inclination.max"],
        }

    all_points, all_intensities = [], []
    for _, row in frame_rows.iterrows():
        ln = row["key.laser_name"]
        if ln not in calibrations:
            continue
        c = calibrations[ln]
        shape = row["[LiDARComponent].range_image_return1.shape"]
        values = row["[LiDARComponent].range_image_return1.values"]
        if shape is None or values is None:
            continue
        pts, ints = convert_range_image_to_xyz(
            values, shape, c["extrinsic"], c["beam_values"], c["beam_min"], c["beam_max"]
        )
        all_points.append(pts)
        all_intensities.append(ints)

    merged_pts = np.vstack(all_points)
    merged_int = np.concatenate(all_intensities)

    # Downsample if too many points
    if len(merged_pts) > 50000:
        indices = np.random.choice(len(merged_pts), 50000, replace=False)
        merged_pts = merged_pts[indices]
        merged_int = merged_int[indices]

    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(merged_pts.astype(np.float64))
    # Clip intensity outliers (99th percentile) before normalizing — Waymo has extreme spikes
    p99 = np.percentile(merged_int, 99)
    clipped = np.clip(merged_int, 0, max(p99, 1e-6))
    norm = (clipped - clipped.min()) / (clipped.max() - clipped.min() + 1e-8)
    colors = np.stack([norm, norm, norm], axis=1).astype(np.float64)
    pcd.colors = o3d.utility.Vector3dVector(colors)

    assert pcd.has_colors(), "PLY point cloud has no colors — check intensity data"

    ply_path = tempfile.mktemp(suffix=".ply")
    o3d.io.write_point_cloud(ply_path, pcd, write_ascii=True)

    # Verify PLY header contains RGB properties
    with open(ply_path, "r") as f:
        header = ""
        for line in f:
            header += line
            if line.strip() == "end_header":
                break
    if "red" not in header or "green" not in header or "blue" not in header:
        print(f"[waymo] WARNING: PLY header missing RGB properties!\n{header}")

    with open(ply_path, "rb") as f:
        ply_bytes = f.read()
    os.unlink(ply_path)
    return ply_bytes, int(target_ts), len(merged_pts)


def upload_to_gcs(data, gcs_path):
    tmp = tempfile.mktemp()
    with open(tmp, "wb") as f:
        f.write(data)
    import subprocess
    result = subprocess.run(
        ["gsutil", "cp", tmp, f"gs://{GCS_BUCKET_NAME}/{gcs_path}"],
        capture_output=True, text=True,
    )
    os.unlink(tmp)
    if result.returncode != 0:
        raise Exception(f"gsutil upload failed: {result.stderr}")
    return f"gs://{GCS_BUCKET_NAME}/{gcs_path}"


def write_waymo_cuboid_predictions(client, project_hash, ontology_hash, scene_title, box_bytes, target_ts):
    from encord.objects.coordinates import CuboidCoordinates

    box_df = pq.read_table(io.BytesIO(box_bytes)).to_pandas()
    frame_boxes = box_df[box_df["key.frame_timestamp_micros"] == target_ts]
    if frame_boxes.empty:
        return 0

    ontology = client.get_ontology(ontology_hash)
    project = client.get_project(project_hash)

    target_row = None
    for lr in project.list_label_rows_v2():
        if lr.data_title == scene_title:
            target_row = lr
            break
    if not target_row:
        return 0

    target_row.initialise_labels()
    n = 0
    for _, box in frame_boxes.iterrows():
        ont_name = WAYMO_BOX_TYPE_MAP.get(box.get("[LiDARBoxComponent].type", 0))
        if not ont_name:
            continue
        try:
            ont_obj = ontology.structure.get_child_by_title(ont_name)
        except Exception:
            continue

        instance = ont_obj.create_instance()
        coords = CuboidCoordinates(
            position=(
                float(box["[LiDARBoxComponent].box.center.x"]),
                float(box["[LiDARBoxComponent].box.center.y"]),
                float(box["[LiDARBoxComponent].box.center.z"]),
            ),
            orientation=(
                0.0,
                0.0,
                float(box.get("[LiDARBoxComponent].box.heading", 0)),
            ),
            size=(
                float(box["[LiDARBoxComponent].box.size.x"]),
                float(box["[LiDARBoxComponent].box.size.y"]),
                float(box["[LiDARBoxComponent].box.size.z"]),
            ),
        )
        instance.set_for_frames(coords, frames=0, confidence=0.95, manual_annotation=False)
        target_row.add_object_instance(instance)
        n += 1

    target_row.save()
    return n


def _send_waymo_lidar_to_encord(scenario_id, scenario_prefix, frame_index=None):
    """Full Waymo LiDAR pipeline: parquet → PLY → GCS → Encord scene → cuboid predictions."""
    import traceback

    try:
        client = get_encord()
        project = client.get_project(PROJECT_HASH)

        scene_title = f"waymo_{scenario_id[:8]}_3d"

        # Check if already exists
        for lr in project.list_label_rows_v2():
            if lr.data_title == scene_title:
                return {
                    "success": True,
                    "status": "already_existed",
                    "already_existed": True,
                    "title": scene_title,
                }

        # Download parquet files from GCS
        print(f"[waymo] Downloading lidar...")
        lidar_resp = http_requests.get(f"{WAYMO_GCS_BASE}/lidar/{scenario_id}.parquet", timeout=300)
        lidar_resp.raise_for_status()

        print(f"[waymo] Downloading calibration...")
        calib_resp = http_requests.get(f"{WAYMO_GCS_BASE}/lidar_calibration/{scenario_id}.parquet", timeout=60)
        calib_resp.raise_for_status()

        print(f"[waymo] Downloading lidar_box...")
        box_resp = http_requests.get(f"{WAYMO_GCS_BASE}/lidar_box/{scenario_id}.parquet", timeout=120)
        box_resp.raise_for_status()

        # Convert to PLY
        print(f"[waymo] Converting to PLY...")
        ply_bytes, frame_ts, n_points = waymo_parquet_to_ply(lidar_resp.content, calib_resp.content, frame_index=frame_index)
        print(f"[waymo] PLY: {n_points} points")

        # Upload PLY to GCS
        ply_gcs_path = f"{GCS_LIDAR_FOLDER}/{scene_title}.ply"
        print(f"[waymo] Uploading PLY to GCS...")
        ply_gcs_uri = upload_to_gcs(ply_bytes, ply_gcs_path)

        # Try to download and upload camera image
        cam_gcs_uri = None
        try:
            print(f"[waymo] Downloading camera_image parquet...")
            cam_resp = http_requests.get(f"{WAYMO_GCS_BASE}/camera_image/{scenario_id}.parquet", timeout=120)
            cam_resp.raise_for_status()
            cam_df = pq.read_table(io.BytesIO(cam_resp.content)).to_pandas()
            # Front camera = camera_name 1
            front_frame = cam_df[
                (cam_df["key.frame_timestamp_micros"] == frame_ts) &
                (cam_df["key.camera_name"] == 1)
            ]
            if not front_frame.empty:
                jpeg_bytes = bytes(front_frame.iloc[0]["[CameraImageComponent].image"])
                cam_gcs_path = f"{GCS_LIDAR_FOLDER}/{scene_title}_front.jpg"
                cam_gcs_uri = upload_to_gcs(jpeg_bytes, cam_gcs_path)
                print(f"[waymo] Camera image uploaded ({len(jpeg_bytes)} bytes)")
            else:
                print(f"[waymo] No front camera image for ts={frame_ts}")
        except Exception as cam_err:
            print(f"[waymo] Camera download failed (falling back to lidar-only): {cam_err}")

        # Create Encord scene — 3-stream if camera available, lidar-only otherwise
        if cam_gcs_uri:
            print(f"[waymo] Creating 3-stream Encord scene...")
            task_created = create_3stream_scene(
                client, scene_title, ply_gcs_uri, cam_gcs_uri,
                cam_w=1920, cam_h=1280, cam_fx=2000.0, cam_fy=2000.0, cam_ox=960.0, cam_oy=640.0,
            )
        else:
            print(f"[waymo] Creating lidar-only Encord scene...")
            task_created = create_lidar_only_scene(client, scene_title, ply_gcs_uri)

        # Write cuboid predictions
        n_cuboids = 0
        try:
            n_cuboids = write_waymo_cuboid_predictions(
                client, PROJECT_HASH, LIDAR_ONTOLOGY_HASH, scene_title, box_resp.content, frame_ts
            )
            print(f"[waymo] {n_cuboids} cuboids written")
        except Exception as e:
            print(f"[waymo] Cuboid writing failed: {e}")
            traceback.print_exc()

        return {
            "success": True,
            "status": "uploaded_and_created",
            "title": scene_title,
            "n_points": n_points,
            "n_cuboids": n_cuboids,
            "task_created": task_created,
        }

    except Exception as e:
        traceback.print_exc()
        raise


# ---------------------------------------------------------------------------
# Status endpoint — query Encord workflow statuses
# ---------------------------------------------------------------------------

@app.get("/api/encord/status")
async def get_encord_status():
    """
    Return workflow status for all label rows in the project.
    Cached for 30 seconds.
    """
    global _status_cache, _status_cache_time

    if _status_cache is not None and (time.time() - _status_cache_time) < STATUS_CACHE_TTL:
        return _status_cache

    try:
        result = await asyncio.to_thread(_fetch_encord_status)
        _status_cache = result
        _status_cache_time = time.time()
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _fetch_encord_status() -> dict:
    """Synchronous — fetch all label row statuses from Encord."""
    client = get_encord()
    project = client.get_project(PROJECT_HASH)

    statuses: dict[str, str] = {}
    for label_row in project.list_label_rows_v2():
        title = label_row.data_title or ""
        node = label_row.workflow_graph_node
        workflow_status = node.title if node else "Unknown"
        # Use the full data_title as the key (e.g. "av2_0b86f508_42agents_7peds")
        if title:
            statuses[title] = workflow_status

    return {"statuses": statuses}
