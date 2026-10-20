-- Amharic Captions for DaVinci Resolve (Workspace > Scripts > Amharic Captions), 1.57.0.
-- Installed by Amharic Captions Studio, which writes the captions to DATA.
--
-- Puts the captions, styled, as Text+ titles over the CURRENT timeline:
--  * they are built in their own timeline "Amharic Captions - <name>" (a copy
--    of yours, emptied: same size, frame rate and start), where inserting a
--    title can never push anything;
--  * that timeline goes on ONE new video track on top of yours, while every
--    one of your tracks is locked — your edit never moves; checked after;
--  * right-click it > "Decompose in Place" = every caption is its own Text+.
-- Each piece of each video on the timeline gets the captions of that part of
-- the file (cut, moved, reordered: still in sync). Speed changes are not followed.
local DATA = nil   -- set by the Studio on install: the captions file

local R = resolve or (Resolve and Resolve()) or (bmd and bmd.scriptapp and bmd.scriptapp("Resolve"))
local FU = fusion or fu or app
local D = nil
local function tx(am, en) return (D and D.lang == "en") and en or am end

-- the result as a MARKER (DaVinci free shows no script windows, and the
-- Console is closed when the script runs from the menu): on our captions
-- block when it worked, else a red one at the playhead; hover = the note.
-- + a small window where DaVinci allows one (Studio), + the Console.
local function say(lines, item)
  local msg = table.concat(lines, "\n")
  print("== Amharic Captions ==\n" .. msg)
  pcall(function()
    if item then
      item:AddMarker(0, "Green", "Amharic Captions", msg, 1)
      return
    end
    local pr = R:GetProjectManager():GetCurrentProject()
    local t = pr and pr:GetCurrentTimeline()
    if not t then return end
    local f = math.floor((tonumber(t:GetSetting("timelineFrameRate")) or 24) + 0.5)
    local h, m, s, fr = (t:GetCurrentTimecode() or ""):match("(%d+)%D(%d+)%D(%d+)%D(%d+)")
    local at = h and ((tonumber(h) * 3600 + tonumber(m) * 60 + tonumber(s)) * f + tonumber(fr) - t:GetStartFrame()) or 0
    if at < 0 then at = 0 end
    for i = 0, 10 do                       -- a frame with no marker yet
      if t:AddMarker(at + i, "Red", "Amharic Captions", msg, 1) then break end
    end
  end)
  pcall(function()
    local ui = FU.UIManager
    local disp = bmd.UIDispatcher(ui)
    local win = disp:AddWindow({ ID = "AmhCaptions", WindowTitle = "Amharic Captions", Geometry = { 420, 300, 520, 240 } },
      ui:VGroup({ ui:Label({ ID = "Msg", Text = msg, WordWrap = true, Alignment = { AlignTop = true } }),
                  ui:HGroup({ Weight = 0, ui:HGap(0, 1), ui:Button({ ID = "OK", Text = "OK" }) }) }))
    function win.On.OK.Clicked(ev) disp:ExitLoop() end
    function win.On.AmhCaptions.Close(ev) disp:ExitLoop() end
    win:Show(); disp:RunLoop(); win:Hide()
  end)
end

local function norm(p) return string.lower((p or ""):gsub("\\", "/")) end
local function base(p) return norm(p):match("([^/]+)$") or "" end

-- ── the captions file
local ok, err = pcall(function() D = dofile(DATA) end)
if not ok or type(D) ~= "table" then
  say({ "Amharic Captions Studio: ⬆ Export → DaVinci — " .. tostring(err or "") ,
        "በStudio ውስጥ መጀመሪያ «⬆ Export → DaVinci» ይጫኑ።", "First press «⬆ Export → DaVinci» in the Studio." })
  return
end
local proj = R:GetProjectManager():GetCurrentProject()
if not proj then say({ tx("መጀመሪያ በDaVinci ውስጥ አንድ Project ይክፈቱ (ወይም New Project)።", "First open a project in DaVinci (or New Project).") }); return end
local mp = proj:GetMediaPool()

-- ── where each of our videos is on a timeline: [tlStart, tlEnd) <- file seconds from src
local wanted = {}
for _, v in ipairs(D.videos or {}) do wanted[#wanted + 1] = v end
local function videoFor(mpi)
  local fp = mpi and mpi:GetClipProperty("File Path")
  if not fp or fp == "" then return nil end
  for _, v in ipairs(wanted) do if norm(v.path) == norm(fp) then return v end end
  for _, v in ipairs(wanted) do if base(v.path) == base(fp) then return v end end
  return nil
end
local function findPieces(t0)
  local pcs, w0, h0 = {}, nil, nil
  local rate = tonumber(t0:GetSetting("timelineFrameRate")) or 24
  for t = 1, t0:GetTrackCount("video") do
    for _, it in ipairs(t0:GetItemListInTrack("video", t) or {}) do
      local mpi = it.GetMediaPoolItem and it:GetMediaPoolItem()
      local v = videoFor(mpi)
      if v then
        local src
        if it.GetSourceStartTime then src = it:GetSourceStartTime() end
        if type(src) ~= "number" then
          local cf = tonumber(mpi:GetClipProperty("FPS")) or rate
          src = (it.GetSourceStartFrame and it:GetSourceStartFrame() or it:GetLeftOffset()) / cf
        end
        pcs[#pcs + 1] = { v = v, a = it:GetStart(), b = it:GetEnd(), src = src, track = t }
        local res = mpi:GetClipProperty("Resolution") or ""
        local rw, rh = res:match("(%d+)%s*x%s*(%d+)")
        if rw and not w0 then w0, h0 = tonumber(rw), tonumber(rh) end
      end
    end
  end
  return pcs, w0, h0
end

-- 1.57: the open timeline when it has the video; else another timeline of
-- this project that has it; else a NEW timeline with the video (its own
-- size and frame rate) — nothing of yours is changed for that
local tl = proj:GetCurrentTimeline()
local pieces, vw, vh = {}, nil, nil
if tl then pieces, vw, vh = findPieces(tl) end
if #pieces == 0 then
  for i = 1, proj:GetTimelineCount() do
    local t2 = proj:GetTimelineByIndex(i)
    if t2 and not (tl and t2:GetName() == tl:GetName()) and not t2:GetName():find("^Amharic Captions") then
      local p2, w2, h2 = findPieces(t2)
      if #p2 > 0 then tl, pieces, vw, vh = t2, p2, w2, h2; proj:SetCurrentTimeline(t2); break end
    end
  end
end
local created = nil
if #pieces == 0 then
  -- the videos: already in the Media Pool, else imported
  local items, have = {}, {}
  pcall(function()
    for _, c in ipairs(mp:GetRootFolder():GetClipList() or {}) do
      local v = videoFor(c)
      if v and not have[v] then have[v] = c end
    end
  end)
  for _, v in ipairs(wanted) do
    local c = have[v]
    if not c then
      local got = mp:ImportMedia({ v.path }) or {}
      if #got == 0 then got = mp:ImportMedia({ (v.path:gsub("/", "\\")) }) or {} end
      c = got[1]
    end
    if c then items[#items + 1] = c end
  end
  if #items == 0 then
    local names = {}
    for _, v in ipairs(wanted) do names[#names + 1] = v.path end
    say({ tx("ቪዲዮውን ማስገባት አልተቻለም፦ ", "Could not bring in the video: ") .. table.concat(names, ", "),
          tx("ፋይሉ አሁንም እዚያ መኖሩን ያረጋግጡ፣ ወይም ቪዲዮውን ወደ Timeline ጎትተው እንደገና ይሞክሩ።", "Check the file is still there, or drag the video onto a timeline and try again.") })
    return
  end
  local nm = (base(wanted[1].path):gsub("%.[^.]*$", "")) .. " - captions"
  local nt = mp:CreateEmptyTimeline(nm) or mp:CreateEmptyTimeline(nm .. " " .. tostring(math.random(100, 999)))
  if not nt then say({ tx("አዲስ Timeline መስራት አልተቻለም።", "Could not make a new timeline.") }); return end
  proj:SetCurrentTimeline(nt)
  -- the video's own size and frame rate (a vertical video = a vertical timeline)
  pcall(function()
    local res = items[1]:GetClipProperty("Resolution") or ""
    local rw, rh = res:match("(%d+)%s*x%s*(%d+)")
    local fr = items[1]:GetClipProperty("FPS")
    nt:SetSetting("useCustomSettings", "1")
    if rw then
      nt:SetSetting("timelineResolutionWidth", rw); nt:SetSetting("timelineResolutionHeight", rh)
      nt:SetSetting("timelineOutputResolutionWidth", rw); nt:SetSetting("timelineOutputResolutionHeight", rh)
    end
    if fr and fr ~= "" then nt:SetSetting("timelineFrameRate", tostring(fr)) end
  end)
  mp:AppendToTimeline(items)
  tl = nt
  created = nt:GetName()
  pieces, vw, vh = findPieces(tl)
end
if not tl or #pieces == 0 then
  local names = {}
  for _, v in ipairs(wanted) do names[#names + 1] = base(v.path) end
  say({ tx("ቪዲዮው በዚህ Project ውስጥ አልተገኘም፦ ", "The video is not in this project: ") .. table.concat(names, ", "),
        tx("ቪዲዮውን ወደ Timeline ጎትተው እንደገና ይሞክሩ።", "Drag the video onto a timeline and try again.") })
  return
end
local fps = tonumber(tl:GetSetting("timelineFrameRate")) or 24
local W = tonumber(tl:GetSetting("timelineResolutionWidth")) or 1920
local H = tonumber(tl:GetSetting("timelineResolutionHeight")) or 1080
local s0 = tl:GetStartFrame()

-- ── every caption in timeline frames (a cue split by a cut = two captions)
local caps = {}
for _, pc in ipairs(pieces) do
  for _, c in ipairs(pc.v.cues or {}) do
    local a = pc.a + math.floor((c[1] - pc.src) * fps + 0.5)
    local b = pc.a + math.floor((c[2] - pc.src) * fps + 0.5)
    if a < pc.a then a = pc.a end
    if b > pc.b then b = pc.b end
    if b - a >= 2 then caps[#caps + 1] = { a = a, b = b, text = c[3] } end
  end
end
table.sort(caps, function(x, y) return x.a < y.a end)
local list = {}
for _, c in ipairs(caps) do                -- never two at once: the earlier one ends
  local prev = list[#list]
  if prev and c.a < prev.b then prev.b = c.a end
  if prev and prev.b - prev.a < 2 then list[#list] = nil end
  list[#list + 1] = c
end
if #list == 0 then say({ tx("ቪዲዮው ተገኝቷል፣ ግን በTimeline ላይ ባሉት ክፍሎቹ ውስጥ ካፕሽን የለም።", "The video was found, but no captions fall in the parts of it on the timeline.") }); return end

-- ── the look: the font's height is a share of the picture's height; the
-- picture is the video's own area (a tall video on a wide timeline too)
local L = D.look or {}
local picW = W
if vw and vh and vh > 0 then picW = math.min(W, H * vw / vh) end
local tall = (vw and vh and vh > vw) or H > W
local em = (L.em or ((tall and 0.05 or 0.065) * (L.k or 1))) * H   -- pixels
-- the text's middle (0-1 from the top) for n lines: the Studio's dragged
-- height = the bottom edge; else its position (as amh_styles places them)
local lineH = em * 1.25 / H
local function middle(n)
  local h = n * lineH
  if type(L.y) == "number" then return L.y - h / 2 end
  if L.pos == "middle" then return 0.5 end
  if L.pos == "top" then return 0.12 + h / 2 end
  if L.pos == "safe" then return (tall and 0.70 or 0.84) - h / 2 end
  return (tall and 0.76 or 0.90) - h / 2
end
local size = em / W                                    -- Text+ Size: of the frame width
local perLine = math.max(6, math.floor(0.86 * picW / (0.62 * em)))
local function chars(s) local n = 0; for _ in s:gmatch("[^\128-\191][\128-\191]*") do n = n + 1 end; return n end
local function wrap(s)
  -- two balanced lines (1.50): the space nearest the middle, when it fits
  if L.lines == 2 and s:find(" ") and chars(s) <= 2 * perLine then
    local n, best, bi, k = chars(s), nil, nil, 0
    for pos, ch in s:gmatch("()([^\128-\191][\128-\191]*)") do
      if ch == " " and (not best or math.abs(n - 1 - 2 * k) < best) then best, bi = math.abs(n - 1 - 2 * k), pos end
      k = k + 1
    end
    if bi then return s:sub(1, bi - 1) .. "\n" .. s:sub(bi + 1), 2 end
  end
  if chars(s) <= perLine then return s, 1 end
  local lines, cur = {}, ""
  for w in s:gmatch("%S+") do
    if cur ~= "" and chars(cur .. " " .. w) > perLine then lines[#lines + 1] = cur; cur = w
    else cur = (cur == "") and w or (cur .. " " .. w) end
  end
  if cur ~= "" then lines[#lines + 1] = cur end
  return table.concat(lines, "\n"), #lines
end
local function style(tool, text)
  local t, n = wrap(text)
  tool:SetInput("StyledText", t)
  tool:SetInput("Font", L.font or "Noto Sans Ethiopic")
  tool:SetInput("Style", L.style or "Bold")
  tool:SetInput("Size", size)
  local c = L.color or { 1, 1, 1 }
  tool:SetInput("Red1", c[1]); tool:SetInput("Green1", c[2]); tool:SetInput("Blue1", c[3])
  tool:SetInput("Center", { 0.5, 1 - middle(n) })   -- Text+ counts from the bottom
  if L.box then
    tool:SetInput("Enabled4", 1); tool:SetInput("Red4", 0); tool:SetInput("Green4", 0); tool:SetInput("Blue4", 0); tool:SetInput("Alpha4", 0.6)
  elseif L.outline ~= false then
    tool:SetInput("Enabled2", 1); tool:SetInput("Thickness2", 0.08)
    tool:SetInput("Red2", 0); tool:SetInput("Green2", 0); tool:SetInput("Blue2", 0)
  end
end

-- ── 1) the captions timeline: a copy of yours, emptied (same size/fps/start)
local function stamp() return tostring(math.random(100, 999)) end
local name = "Amharic Captions - " .. tl:GetName()
for i = 1, proj:GetTimelineCount() do
  if proj:GetTimelineByIndex(i):GetName() == name then name = name .. " " .. stamp() break end
end
local ct = tl:DuplicateTimeline(name)
if not ct then say({ tx("የካፕሽን Timeline መስራት አልተቻለም።", "Could not make the captions timeline.") }); proj:SetCurrentTimeline(tl); return end
proj:SetCurrentTimeline(ct)
for _, kind in ipairs({ "video", "audio", "subtitle" }) do
  for t = 1, ct:GetTrackCount(kind) do
    if ct.SetTrackLock then ct:SetTrackLock(kind, t, false) end
    local all = ct:GetItemListInTrack(kind, t) or {}
    if #all > 0 then ct:DeleteClips(all, false) end
  end
end
local function tc(frame)
  local f = frame
  local h = math.floor(f / (fps * 3600)); f = f - h * fps * 3600
  local m = math.floor(f / (fps * 60)); f = f - m * fps * 60
  local s = math.floor(f / fps); f = f - s * fps
  return string.format("%02d:%02d:%02d:%02d", h, m, s, math.floor(f))
end
-- the split trick: a title at the caption's start, a "cutter" at its end,
-- then only the pieces that start at a caption's start stay
for _, c in ipairs(list) do
  ct:SetCurrentTimecode(tc(c.a))
  local it = ct:InsertFusionTitleIntoTimeline("Text+")
  local comp = it and it:GetFusionCompByIndex(1)
  local tool = comp and comp:FindToolByID("TextPlus")
  if tool then style(tool, c.text) end
  ct:SetCurrentTimecode(tc(c.b))
  ct:InsertFusionTitleIntoTimeline("Text+")
end
local starts = {}
for _, c in ipairs(list) do starts[c.a] = true end
local drop = {}
for _, it in ipairs(ct:GetItemListInTrack("video", 1) or {}) do
  if starts[it:GetStart()] then starts[it:GetStart()] = nil else drop[#drop + 1] = it end
end
if #drop > 0 then ct:DeleteClips(drop, false) end
local made = 0
for i, it in ipairs(ct:GetItemListInTrack("video", 1) or {}) do
  made = made + 1
  if it.SetName then pcall(function() it:SetName("Amharic caption " .. i) end) end
end

-- ── 2) onto your timeline: everything locked, one new track on top
proj:SetCurrentTimeline(tl)
local function snapshot()
  local out = {}
  for _, kind in ipairs({ "video", "audio", "subtitle" }) do
    for t = 1, tl:GetTrackCount(kind) do
      for _, it in ipairs(tl:GetItemListInTrack(kind, t) or {}) do
        out[#out + 1] = kind .. t .. ":" .. it:GetName() .. "@" .. it:GetStart() .. "-" .. it:GetEnd()
      end
    end
  end
  return out
end
local before = snapshot()
-- an older captions track of ours is turned off (kept: your edits in it stay)
local old = {}
for t = 1, tl:GetTrackCount("video") do
  local items = tl:GetItemListInTrack("video", t) or {}
  local ours = #items > 0
  for _, it in ipairs(items) do
    local n = it:GetName() or ""
    if not (n:find("^Amharic Captions") or n:find("^Amharic caption")) then ours = false end
  end
  if ours and (not tl.GetIsTrackEnabled or tl:GetIsTrackEnabled("video", t)) then old[#old + 1] = t end
end
local locks = {}
for _, kind in ipairs({ "video", "audio", "subtitle" }) do
  for t = 1, tl:GetTrackCount(kind) do
    locks[#locks + 1] = { kind, t, tl.GetIsTrackLocked and tl:GetIsTrackLocked(kind, t) or false }
    tl:SetTrackLock(kind, t, true)
  end
end
tl:AddTrack("video")
local top = tl:GetTrackCount("video")
local mpi = ct:GetMediaPoolItem()
local placed = mpi and mp:AppendToTimeline({ { mediaPoolItem = mpi, recordFrame = s0, trackIndex = top, mediaType = 1 } })
for _, l in ipairs(locks) do tl:SetTrackLock(l[1], l[2], l[3]) end
for _, t in ipairs(old) do if tl.SetTrackEnable then tl:SetTrackEnable("video", t, false) end end
if tl.SetTrackName then pcall(function() tl:SetTrackName("video", top, "Amharic Captions") end) end

-- ── 3) check: nothing of yours moved
local after = snapshot()
local same = #after >= #before
local seen = {}
for _, s in ipairs(after) do seen[s] = true end
for _, s in ipairs(before) do if not seen[s] then same = false end end
local lines = {}
if not placed or #placed == 0 then
  lines[#lines + 1] = tx("ካፕሽኖቹ ተሰርተዋል (Timeline «" .. name .. "»)፣ ግን በቪዲዮዎ ላይ መጨመር አልተቻለም። ከMedia Pool ወደ ላይኛው track ይጎትቱት።",
                         "The captions are made (timeline «" .. name .. "»), but could not be put on your video. Drag it from the Media Pool onto a top track.")
else
  lines[#lines + 1] = "✓ " .. made .. tx(" ካፕሽኖች በV" .. top .. " ላይ ገብተዋል።", " captions are on track V" .. top .. ".")
  lines[#lines + 1] = tx("ለማረም፦ በV" .. top .. " ያለውን ብሎክ Right-click → «Decompose in Place» — እያንዳንዱ ካፕሽን የራሱ Text+ ይሆናል (Inspector → Text)።",
                         "To edit: right-click the block on V" .. top .. " → «Decompose in Place» — every caption becomes its own Text+ (Inspector → Text).")
  if #old > 0 then lines[#lines + 1] = tx("የቀድሞው ካፕሽን track (V" .. table.concat(old, ", V") .. ") ጠፍቷል (አልተሰረዘም)።", "Your older captions track (V" .. table.concat(old, ", V") .. ") is turned off (not deleted).") end
end
if vw and vh and vh > vw and W > H then
  lines[#lines + 1] = tx("ምክር፦ ቪዲዮው ቁመታዊ ነው ግን Timeline ስፋታዊ (" .. W .. "×" .. H .. ") ነው — ለTikTok/Reels Timeline 1080×1920 ያድርጉ።",
                         "Tip: the video is vertical but the timeline is wide (" .. W .. "×" .. H .. ") — for TikTok/Reels use a 1080×1920 timeline.")
end
if created then
  lines[#lines + 1] = tx("✓ አዲስ Timeline «" .. created .. "» ከቪዲዮዎ ጋር ተሰርቷል (በMedia Pool ውስጥ)።", "✓ A new timeline «" .. created .. "» was made with your video (in the Media Pool).")
end
lines[#lines + 1] = same and tx("✓ ቪዲዮዎ አልተነካም።", "✓ Your video was not touched.")
                         or tx("⚠ በTimelineዎ ውስጥ የተቀየረ ነገር አለ — Ctrl+Z ይጫኑ።", "⚠ Something in your timeline changed — press Ctrl+Z.")
say(lines, same and placed and placed[1] or nil)
