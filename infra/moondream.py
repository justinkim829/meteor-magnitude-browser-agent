import modal
import subprocess
import os
import requests

app = modal.App('moondream')
volume = modal.Volume.from_name('moondream', create_if_missing=True)

SERVER_DOWNLOAD_URL = "https://d32juh9nlxrs68.cloudfront.net/moondream-server-linux-cuda12-4-v1-0-1"
SERVER_DEST_PATH = "/moondream/server"
HF_CACHE_DIR = "/moondream/cache"

image = (
    modal.Image.debian_slim(python_version='3.11')
    .apt_install("libvips-dev", "pkg-config")
    .pip_install("requests")
)

@app.function(
    image=image,
    gpu="A10G",
    volumes={"/moondream": volume},
    timeout=1800,
    scaledown_window=300, # 5 minutes
    #min_containers=1 # uncomment to keep a container warm 24/7 (expensive!)
)
@modal.web_server(port=2020, startup_timeout=600, label="moondream")
def server():
    os.environ['HF_HOME'] = HF_CACHE_DIR
    os.makedirs(HF_CACHE_DIR, exist_ok=True)

    if not os.path.exists(SERVER_DEST_PATH):
        try:
            with requests.get(SERVER_DOWNLOAD_URL, stream=True) as r:
                r.raise_for_status()
                with open(SERVER_DEST_PATH, 'wb') as f:
                    for chunk in r.iter_content(chunk_size=8192):
                        f.write(chunk)
            # Commit the downloaded file explicitly to the persistent volume
            volume.commit()
        except requests.exceptions.RequestException as e:
            # Minimal error handling for download failure
            raise RuntimeError(f"Failed to download server: {e}")

    # Set execute permissions, raise error automatically if it fails
    subprocess.run(["chmod", "+x", SERVER_DEST_PATH], check=True)

    server_args = [SERVER_DEST_PATH]
    subprocess.Popen(server_args)
    # Function exits, Modal keeps container alive for the web server