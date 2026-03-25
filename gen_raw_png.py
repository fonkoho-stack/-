import struct
import zlib
import os

def make_png(width, height, r, g, b):
    # build the raw pixels (Filter byte 0, followed by RGB stream)
    row = b'\0' + bytes([r, g, b]) * width
    raw = row * height
    
    # compress
    idat = zlib.compress(raw)
    
    def chunk(chunk_type, data):
        return struct.pack('>I', len(data)) + chunk_type + data + struct.pack('>I', zlib.crc32(chunk_type + data) & 0xFFFFFFFF)
    
    png = b'\x89PNG\r\n\x1A\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) # 8-bit truecolor
    png += chunk(b'IDAT', idat)
    png += chunk(b'IEND', b'')
    return png

gray = make_png(81, 81, 142, 142, 147) # 8E8E93
green = make_png(81, 81, 52, 199, 89)  # 34C759

d = "d:/soft/python-progress/course_reminder/miniprogram/images"
os.makedirs(d, exist_ok=True)

open(f"{d}/icon_upload.png", "wb").write(gray)
open(f"{d}/icon_upload_active.png", "wb").write(green)
open(f"{d}/icon_schedule.png", "wb").write(gray)
open(f"{d}/icon_schedule_active.png", "wb").write(green)
open(f"{d}/icon_settings.png", "wb").write(gray)
open(f"{d}/icon_settings_active.png", "wb").write(green)

print("Generated crystal clear 81x81 raw PNGs.")
