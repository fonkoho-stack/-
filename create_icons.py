import os
import base64

img_dir = "d:/soft/python-progress/course_reminder/miniprogram/images"
os.makedirs(img_dir, exist_ok=True)

# Minimum valid 1x1 transparent PNG
b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
png_data = base64.b64decode(b64)

files_to_create = [
    "icon_upload.png", "icon_upload_active.png",
    "icon_schedule.png", "icon_schedule_active.png",
    "icon_settings.png", "icon_settings_active.png"
]

for filename in files_to_create:
    with open(os.path.join(img_dir, filename), "wb") as f:
        f.write(png_data)

print(f"Created {len(files_to_create)} images in {img_dir}")
