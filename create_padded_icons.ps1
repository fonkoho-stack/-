[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
$dir = "d:\soft\python-progress\course_reminder\miniprogram\images\"
Add-Type -AssemblyName System.Drawing

function Download-And-Pad-Icon($url, $file) {
    $tempFile = $dir + "temp_" + $file
    $outFile = $dir + $file
    Try {
        Invoke-WebRequest -Uri $url -OutFile $tempFile -UserAgent $ua -UseBasicParsing -TimeoutSec 15
        
        $canvas = New-Object System.Drawing.Bitmap(81, 81)
        $g = [System.Drawing.Graphics]::FromImage($canvas)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.Clear([System.Drawing.Color]::Transparent)
        
        $src = [System.Drawing.Image]::FromFile($tempFile)
        # 将原始的高清图标缩小至 45x45，并绝对居中绘制于 81x81 的全透明画板内 (四周保留 18px 的物理死区)
        $g.DrawImage($src, 18, 18, 45, 45)
        
        $g.Dispose()
        $src.Dispose()
        
        $canvas.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
        $canvas.Dispose()
        
        Remove-Item $tempFile -Force
        Write-Host "Protected & Padded $file"
    } Catch {
        Write-Host "Failed $file : $_"
    }
}

Download-And-Pad-Icon "https://img.icons8.com/ios/81/8E8E93/upload.png" "icon_upload.png"
Download-And-Pad-Icon "https://img.icons8.com/ios/81/34C759/upload.png" "icon_upload_active.png"
Download-And-Pad-Icon "https://img.icons8.com/ios/81/8E8E93/calendar.png" "icon_schedule.png"
Download-And-Pad-Icon "https://img.icons8.com/ios/81/34C759/calendar.png" "icon_schedule_active.png"
Download-And-Pad-Icon "https://img.icons8.com/ios/81/8E8E93/settings.png" "icon_settings.png"
Download-And-Pad-Icon "https://img.icons8.com/ios/81/34C759/settings.png" "icon_settings_active.png"
