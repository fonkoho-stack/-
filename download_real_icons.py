import urllib.request
import os
import ssl

# 忽略SSL证书错误（防止本地网络截断）
ssl._create_default_https_context = ssl._create_unverified_context

d = "d:/soft/python-progress/course_reminder/miniprogram/images"
os.makedirs(d, exist_ok=True)

# 使用 icons8 的开源 iOS 风格图标 api
# 大小 81，颜色匹配设计稿
icons = {
    "icon_upload.png": "https://img.icons8.com/ios/81/8E8E93/upload.png",
    "icon_upload_active.png": "https://img.icons8.com/ios/81/34C759/upload.png",
    "icon_schedule.png": "https://img.icons8.com/ios/81/8E8E93/calendar.png",
    "icon_schedule_active.png": "https://img.icons8.com/ios/81/34C759/calendar.png",
    "icon_settings.png": "https://img.icons8.com/ios/81/8E8E93/settings.png",
    "icon_settings_active.png": "https://img.icons8.com/ios/81/34C759/settings.png"
}

for name, url in icons.items():
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as response:
            with open(os.path.join(d, name), 'wb') as f:
                f.write(response.read())
        print(f"Downloaded {name} successfully.")
    except Exception as e:
        print(f"Failed to download {name}: {e}")
