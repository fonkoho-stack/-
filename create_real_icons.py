import os
from PIL import Image, ImageDraw, ImageFont

img_dir = "d:/soft/python-progress/course_reminder/miniprogram/images"
os.makedirs(img_dir, exist_ok=True)

icons = {
    "icon_upload.png": ("UP", "#8E8E93"),
    "icon_upload_active.png": ("UP", "#34C759"),
    "icon_schedule.png": ("TB", "#8E8E93"),
    "icon_schedule_active.png": ("TB", "#34C759"),
    "icon_settings.png": ("ST", "#8E8E93"),
    "icon_settings_active.png": ("ST", "#34C759")
}

for filename, (text, color) in icons.items():
    img = Image.new('RGBA', (81, 81), (255, 255, 255, 0))
    d = ImageDraw.Draw(img)
    # Draw a colored circle
    d.ellipse([10, 10, 71, 71], fill=color)
    
    # Try to load a generic font, otherwise default
    try:
        font = ImageFont.truetype("arial.ttf", 24)
    except IOError:
        font = ImageFont.load_default()
        
    # Quick text centering
    bbox = d.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    d.text(((81 - text_w)/2, (81 - text_h)/2 - 4), text, fill="white", font=font)
    
    img.save(os.path.join(img_dir, filename), "PNG")

print("Generated true placeholder icons.")
