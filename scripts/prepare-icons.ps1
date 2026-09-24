param(
  [Parameter(Mandatory = $true)][string]$SourceImage,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

# Package a selected generated source at Chrome's required sizes.
# This only resamples the image; it does not redraw or alter the artwork.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$sourcePath = (Resolve-Path -LiteralPath $SourceImage).Path
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$outputPath = (Resolve-Path -LiteralPath $OutputDirectory).Path
$source = [System.Drawing.Image]::FromFile($sourcePath)
try {
  if ($source.Width -ne $source.Height) { throw 'The icon source must be square.' }
  foreach ($size in @(16, 32, 48, 128)) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($source, [System.Drawing.Rectangle]::new(0, 0, $size, $size))
      $target = Join-Path $outputPath ($size.ToString() + '.png')
      $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Output $target
    } finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }
} finally { $source.Dispose() }
