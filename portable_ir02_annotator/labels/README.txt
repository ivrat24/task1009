# Labels live in the browser localStorage by default and do NOT move with the folder.
#
# Dual-person / dual-machine:
#   - Annotator A on machine A: export → ir02_A_<machine>_..._state.json
#   - Annotator B on machine B: export → ir02_B_<machine>_..._state.json
#   - Put exports in this folder (or share via USB/cloud)
#   - On the other machine: 「导入对方(对比)」 to measure agreement (does not overwrite local slot)
#   - 「导入/合并标注」 restores YOUR own progress into the current annotator slot
#
# Before transferring the portable package:
#   1. Click 「导出标注」 → save JSON into this folder
#   2. Copy the whole portable package + that JSON
# On the new machine:
#   1. START.bat → set annotator + machine ID
#   2. 「导入/合并标注」 to restore your slot
#
# Excel / JSONL exports are for analysis; 「导出标注」 JSON is for restore + dual-machine compare.
