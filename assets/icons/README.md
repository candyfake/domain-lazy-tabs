# 冻结标签图标

用户选择方案 C：挂冰棱的雪花标签。`frozen-tabs-source.png` 是内置 `image_gen` 工具生成的原图。生成接口没有模型选择字段，因此这里不声称确认过具体模型版本。

运行 `scripts/prepare-icons.ps1` 将原图等比例缩小为扩展使用的 16、32、48、128 像素 PNG；不在运行时加载原图或联网生成图标。

```powershell
./scripts/prepare-icons.ps1 -SourceImage assets/icons/frozen-tabs-source.png -OutputDirectory extension/icons
```

## 生成提示词

Use case: logo-brand. Create ONE expressive minimal Chrome extension icon: a BROWSER TAB FROZEN INTO ICE. Square 1024x1024 finished graphic, full-bleed saturated royal blue background fully opaque, no transparency. Large single white-to-pale-cyan browser window centered, with a clearly separated blue browser tab strip across its top. Three bold compact icicle teeth hang from the bottom edge as part of its silhouette. In the main window area a huge navy-blue geometric SIX-POINT SNOWFLAKE, thick branches and strong white negative space. Bright icy turquoise frozen edge accent on right side. Premium contemporary icon design, flat geometric art, crisp clean contours and compelling balanced proportions. Sparse details, icon fills 86% of canvas, must remain recognizable at 16px. No folder flap, no pause/play symbols, no lettering, no photo textures, no multiple objects, no watermark.
