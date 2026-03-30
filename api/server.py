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
        client = get_encord()
        dataset = client.get_dataset(DATASET_HASH)
        project = client.get_project(PROJECT_HASH)

        # ── Step 1: Check if image already exists in dataset ──
        existing_row = find_existing_data_row(dataset, scenario_prefix)

        if existing_row:
            uid = existing_row.uid
            try:
                project.create_label_row(uid=uid)
                return {
                    "success": True,
                    "status": "task_created",
                    "already_existed": False,
                    "uid": uid,
                    "title": existing_row.title,
                }
            except Exception as inner:
                if _is_duplicate_error(inner):
                    return {
                        "success": True,
                        "status": "already_existed",
                        "already_existed": True,
                        "uid": uid,
                        "title": existing_row.title,
                    }
                raise

        # ── Step 2: Find frame from annotations ──
        if frame_index is not None:
            best = find_frame_by_index(scenario_id, frame_index)
        else:
            best = find_best_frame(scenario_id)

        # ── Step 3: Find closest camera timestamp ──
        camera_ts = find_closest_camera_timestamp(
            scenario_id, best["timestamp_ns"]
        )

        # ── Step 4: Download image from S3 ──
        image_bytes = download_camera_image(scenario_id, camera_ts)

        # ── Step 5: Upload to Encord dataset ──
        title = (
            f"{scenario_prefix}"
            f"_{best['n_agents']}agents"
            f"_{best['n_pedestrians']}peds"
        )
        uid = upload_image_to_encord(dataset, image_bytes, title)

        # ── Step 6: Create labeling task ──
        try:
            project.create_label_row(uid=uid)
        except Exception as inner:
            if not _is_duplicate_error(inner):
                raise

        return {
            "success": True,
            "status": "uploaded_and_created",
            "already_existed": False,
            "uid": uid,
            "title": title,
            "best_frame": best,
        }

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
        print(f"[waymo] Uploading to GCS...")
        gcs_uri = upload_to_gcs(ply_bytes, ply_gcs_path)

        # Create Encord scene — matches the working AV2 lidar.events format
        scene_manifest = {
            "scenes": [{
                "title": scene_title,
                "scene": {
                    "lidar": {
                        "type": "point_cloud",
                        "events": [{"uri": gcs_uri}],
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

        print(f"[waymo] Creating Encord scene...")
        job = folder.add_private_data_to_folder_start(gcp_integration.id, scene_json_path)
        folder.add_private_data_to_folder_get_result(job)
        os.unlink(scene_json_path)

        # Link scene from storage folder to dataset
        time.sleep(3)
        dataset_obj = client.get_dataset(DATASET_HASH)
        items = folder.list_items()
        for item in items:
            if item.name == scene_title:
                dataset_obj.link_items(item_uuids=[str(item.uuid)])
                print(f"[waymo] Linked {scene_title} to dataset")
                break

        # Wait for scene to appear in project
        import time as _time
        _time.sleep(3)

        task_created = False
        for lr in project.list_label_rows_v2():
            if lr.data_title == scene_title:
                try:
                    project.create_label_row(uid=lr.data_hash)
                    task_created = True
                except Exception as e:
                    if _is_duplicate_error(e):
                        task_created = True
                break

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
