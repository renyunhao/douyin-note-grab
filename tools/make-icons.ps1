# Renders icons/icon{16,32,48,128}.png from a vector master, one tuned composition per size.
# No third-party deps (GDI+ only). Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-icons.ps1
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$M = 512
$OutDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'icons'
if (-not (Test-Path $OutDir)) { $null = New-Item -ItemType Directory -Path $OutDir }

# Douyin brand duotone.
$CYAN = [System.Drawing.Color]::FromArgb(255, 66, 210, 203)
$PINK = [System.Drawing.Color]::FromArgb(255, 254, 44, 85)
$WHITE = [System.Drawing.Color]::FromArgb(255, 246, 247, 250)
$TILE_TOP = [System.Drawing.Color]::FromArgb(255, 40, 42, 49)
$TILE_BOTTOM = [System.Drawing.Color]::FromArgb(255, 11, 12, 14)
$RIM = [System.Drawing.Color]::FromArgb(46, 255, 255, 255)
$INK = [System.Drawing.Color]::FromArgb(255, 22, 23, 27)

function New-RoundPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = $r * 2
  $null = $p.AddArc($x, $y, $d, $d, 180, 90)
  $null = $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $null = $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $null = $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $null = $p.CloseFigure()
  return $p
}

function Shift-Path($path, [single]$dx, [single]$dy) {
  $mx = [System.Drawing.Drawing2D.Matrix]::new()
  $null = $mx.Translate($dx, $dy)
  $null = $path.Transform($mx)
  return $path
}

# Pen(Color, float) is ambiguous for the PowerShell binder, so always build pens over a brush.
function New-StrokePen($color, [single]$width, [int]$alpha = 255) {
  $c = [System.Drawing.Color]::FromArgb($alpha, $color.R, $color.G, $color.B)
  $script:strokeBrush = [System.Drawing.SolidBrush]::new($c)
  $pen = [System.Drawing.Pen]::new($script:strokeBrush, $width)
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  return $pen
}

function Dispose-StrokePen($pen) {
  $pen.Dispose()
  if ($script:strokeBrush) { $script:strokeBrush.Dispose(); $script:strokeBrush = $null }
}

function Draw-Path($g, $path, $color, [single]$width, [int]$alpha = 255) {
  $pen = New-StrokePen $color $width $alpha
  $g.DrawPath($pen, $path)
  Dispose-StrokePen $pen
}

function Fill-Path($g, $path, $color, [int]$alpha) {
  $c = [System.Drawing.Color]::FromArgb($alpha, $color.R, $color.G, $color.B)
  $brush = [System.Drawing.SolidBrush]::new($c)
  $g.FillPath($brush, $path)
  $brush.Dispose()
}

# The mark: a 图文 card with a down arrow knocked out of it. Solid shapes with negative
# space hold up at 16px; thin outlines and dense CJK strokes do not.
function Draw-GrabMark($g, [single]$weight, [bool]$tray, [single]$shift) {
  $x = [single]118
  $y = [single]100
  $w = [single]276
  $h = [single]312
  $r = [single]44
  if ($shift -gt 0) {
    foreach ($rim in @(
      @{ color = $CYAN; off = -$shift },
      @{ color = $PINK; off = $shift }
    )) {
      $path = Shift-Path (New-RoundPath $x $y $w $h $r) ([single]$rim.off) ([single]0)
      Fill-Path $g $path $rim.color 140
      $path.Dispose()
    }
  }
  $card = New-RoundPath $x $y $w $h $r
  Fill-Path $g $card $WHITE 255
  $card.Dispose()

  $pen = New-StrokePen $INK (40 * $weight) 255
  $null = $g.DrawLine($pen, [single]256, [single]148, [single]256, [single]246)
  $pts = @(
    [System.Drawing.PointF]::new([single]202, [single]200),
    [System.Drawing.PointF]::new([single]256, [single]254),
    [System.Drawing.PointF]::new([single]310, [single]200)
  )
  $null = $g.DrawLines($pen, $pts)
  Dispose-StrokePen $pen

  if ($tray) {
    $pen2 = New-StrokePen $INK (34 * $weight) 255
    $null = $g.DrawLine($pen2, [single]196, [single]322, [single]316, [single]322)
    Dispose-StrokePen $pen2
  }
}

function New-Master([single]$shift, [int]$rimAlpha, [single]$weight, [bool]$tray) {
  $bmp = [System.Drawing.Bitmap]::new($M, $M, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $inset = [single]18
  $side = $M - 2 * $inset
  $tile = New-RoundPath $inset $inset $side $side ([single]110)

  $state = $g.Save()
  $g.SetClip($tile, [System.Drawing.Drawing2D.CombineMode]::Replace)
  $rect = [System.Drawing.RectangleF]::new(0, 0, $M, $M)
  $grad = [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, $TILE_TOP, $TILE_BOTTOM, 90)
  $g.FillRectangle($grad, $rect)
  $g.Restore($state)
  $grad.Dispose()

  # the frame carries the same chroma split as the card, only fainter
  if ($rimAlpha -gt 0) {
    foreach ($rim in @(
      @{ color = $CYAN; off = -4 },
      @{ color = $PINK; off = 4 }
    )) {
      $path = Shift-Path (New-RoundPath $inset $inset $side $side ([single]110)) ([single]$rim.off) ([single]$rim.off)
      Draw-Path $g $path $rim.color 7 ([int]($rimAlpha * 0.6))
      $path.Dispose()
    }
  }
  Draw-Path $g $tile $RIM 5 $RIM.A

  Draw-GrabMark $g $weight $tray $shift

  $tile.Dispose()
  $g.Dispose()
  return $bmp
}

# Same composition at every size; only the stroke weight, the chroma separation and the
# tray line scale, since 16px cannot afford detail. Edit freely and re-run.
$plans = @(
  @{ size = 16; shift = 0; rimAlpha = 60; weight = 1.45; tray = $false },
  @{ size = 32; shift = 5; rimAlpha = 80; weight = 1.15; tray = $true },
  @{ size = 48; shift = 8; rimAlpha = 100; weight = 1.0; tray = $true },
  @{ size = 128; shift = 14; rimAlpha = 130; weight = 0.85; tray = $true }
)

foreach ($plan in $plans) {
  $master = New-Master $plan.shift $plan.rimAlpha $plan.weight $plan.tray
  $bmp = [System.Drawing.Bitmap]::new($plan.size, $plan.size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gs = [System.Drawing.Graphics]::FromImage($bmp)
  $gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gs.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $gs.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $gs.DrawImage($master, [System.Drawing.Rectangle]::new(0, 0, $plan.size, $plan.size))
  $gs.Dispose()
  $file = Join-Path $OutDir ("icon{0}.png" -f $plan.size)
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose(); $master.Dispose()
  Write-Output ("wrote {0} ({1} bytes)" -f $file, (Get-Item $file).Length)
}
