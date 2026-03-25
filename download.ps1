[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
$dir = "d:\soft\python-progress\course_reminder\miniprogram\images\"

function Download-Icon($url, $file) {
    Try {
        Invoke-WebRequest -Uri $url -OutFile ($dir + $file) -UserAgent $ua -UseBasicParsing -TimeoutSec 15
        Write-Host "Downloaded $file"
    } Catch {
        Write-Host "Failed to download $file : $_"
    }
}

Download-Icon "https://img.icons8.com/ios/81/8E8E93/upload.png" "icon_upload.png"
Download-Icon "https://img.icons8.com/ios/81/34C759/upload.png" "icon_upload_active.png"
Download-Icon "https://img.icons8.com/ios/81/8E8E93/calendar.png" "icon_schedule.png"
Download-Icon "https://img.icons8.com/ios/81/34C759/calendar.png" "icon_schedule_active.png"
Download-Icon "https://img.icons8.com/ios/81/8E8E93/settings.png" "icon_settings.png"
Download-Icon "https://img.icons8.com/ios/81/34C759/settings.png" "icon_settings_active.png"
