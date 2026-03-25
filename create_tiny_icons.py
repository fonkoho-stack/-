import base64
import os

red = b"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQIW2P8z8AARAwMjDAGNgwA/1oEAQEH/0gAAAAASUVORK5CYII="
green = b"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQIW2NkgID/DAwMjDAGNgwA92MFAQ7HjxEAAAAASUVORK5CYII="
gray = b"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQIW2OMjIz8z8DAwMgwdgkA21sDAQEHAxsAAAAASUVORK5CYII="

d = "d:/soft/python-progress/course_reminder/miniprogram/images"
os.makedirs(d, exist_ok=True)

open(f"{d}/icon_upload.png", "wb").write(base64.b64decode(gray))
open(f"{d}/icon_upload_active.png", "wb").write(base64.b64decode(green))
open(f"{d}/icon_schedule.png", "wb").write(base64.b64decode(gray))
open(f"{d}/icon_schedule_active.png", "wb").write(base64.b64decode(green))
open(f"{d}/icon_settings.png", "wb").write(base64.b64decode(gray))
open(f"{d}/icon_settings_active.png", "wb").write(base64.b64decode(green))
