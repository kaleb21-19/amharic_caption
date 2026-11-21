# የሚስተካከል የአማርኛ ካፕሽን ቅጥ (MOGRT) · Editable Amharic caption template

## ለባለቤቱ — አንድ ጊዜ ብቻ ማድረግ ያለብዎት

1. **Noto Sans Ethiopic** ፊደል በኮምፒውተርዎ ላይ መጫኑን ያረጋግጡ (በምርቱ `tools/fonts` ውስጥ አለ)።
2. የአሁኑ After Effects ፕሮጀክትዎን **ያስቀምጡ**። ስክሪፕቱ አዲስ ፕሮጀክት ይፈጥራል፤ የእርስዎን ፕሮጀክት አይለውጥም።
3. After Effects ውስጥ File → Scripts → Run Script File… → `tools/mogrt/build_gold_caption.jsx` ይምረጡ።
4. ከዚህ ፋይል ጎን ሁለት ፋይሎች ይወጣሉ፦
   - `Amharic Gold Caption 16:9.mogrt`
   - `Amharic Gold Caption 9:16.mogrt`
5. ሁለቱንም ወደ `panel/mogrt/` ይቅዱ። ዚፑን በሚሰሩበት ጊዜ `panel/*` ሁሉ ስለሚገባ፣ እዚያ ከገቡ በኋላ ልዩ የbuild ለውጥ አያስፈልግም።
6. ፕሮጀክቱ After Effects 2022+ ውስጥ መሰራቱን እና Premiere 2023+ ውስጥ መከፈቱን ይፈትሹ (MOGRT ከአዲስ AE ወደ አሮጌ Premiere ላይገባ ይችላል)።

### ለምን ጽሑፍ በራሱ አንጽፍም

በ 1.94.0 ፓነሉ የአማርኛ ጽሑፍን ወደ MOGRT ለመጻፍ ሞክሯል (`mTextParam` / `textEditValue`)።
Premiere የእንግሊዝኛውን የናሙና ጽሑፍ ይዞ ቀረ፤ ስለዚህ ለተጠቃሚዎች ጽሑፉን **እርሳቸው** በEssential Graphics
የሚያስገቡበት ዝግጁ ቅጥ እንልካለን። ይህ መንገድ 1.94.1 ላይ ተመልሷል — እንደገና አናነቃውም።

## ለአርታኢ — Premiere ውስጥ እንዴት ይጠቀማል

1. Window → Essential Graphics ይክፈቱ።
2. በBrowse ትር ውስጥ **Install Motion Graphics Template** ይጫኑ እና ከምርቱ `com.amharic.captions/mogrt` ፎልደር
   ውስጥ `Amharic Gold Caption 16:9.mogrt` (ወይም 9:16 ለReels/TikTok) ይምረጡ።
3. ቅጥውን በላይኑ ላይ ያስቀምጡ። በEssential Graphics ውስጥ **Caption text** ላይ ጽሑፉን ይተይፉ —
   አማርኛው በትክክል ለማሳየት **Noto Sans Ethiopic** መጫኑን ያረጋግጡ።
4. ሌሎች መቆጣጠሪያዎች፦ **Text size**፣ **Box opacity**፣ **Side margin**፣ **Bottom margin**፣
   **Accent colour**፣ **Show box**። ለውጦቹ በቅጹ ውስጥ ይታያሉ፣ ፊልሙን እንደገና ማስመጣት አያስፈልግም።

---

## For the owner — one-time build

1. Make sure **Noto Sans Ethiopic** is installed (it ships in the product's `tools/fonts`).
2. **Save your current After Effects project.** The script makes a new project; it does not touch yours.
3. In After Effects: File → Scripts → Run Script File… → choose `tools/mogrt/build_gold_caption.jsx`.
4. Two files appear beside the script: `Amharic Gold Caption 16:9.mogrt` and `Amharic Gold Caption 9:16.mogrt`.
5. Copy both into `panel/mogrt/`. Build scripts already copy all of `panel/*`, so no build change is needed.
6. Check the file opens in Premiere 2023+ (a MOGRT from a newer AE may not open in older Premiere).

### Why the panel does not write the text itself

In 1.94.0 the panel tried to write Amharic into a MOGRT (`mTextParam` / `textEditValue`). Premiere kept
the template's own English sample text, so the owner had it removed in 1.94.1. We ship a **ready template**
whose text the editor types in Essential Graphics instead. Do not re-enable automatic text-setting.

## For the editor — using it in Premiere

1. Window → Essential Graphics → Browse → **Install Motion Graphics Template**.
2. Pick `Amharic Gold Caption 16:9.mogrt` (or `9:16` for Reels/TikTok) from the product's
   `com.amharic.captions/mogrt` folder.
3. Drop it on the timeline, then type your text in **Caption text**. Install **Noto Sans Ethiopic** for correct
   Amharic letters.
4. Other controls: **Text size**, **Box opacity**, **Side margin**, **Bottom margin**, **Accent colour**,
   **Show box**. Edits appear immediately — no need to re-import the video.
