# Design QA: Excel 导入工作台

Reference: ImageGen option 2, "造价员 Excel 工作台".

Prototype URL: http://localhost:8000/app/

Captured screenshot: `output/importer-workbench.png`

Checks:
- Default route opens the 数据导入 view.
- Sidebar navigation highlights 数据导入 and preserves existing product modules.
- Main task header, project selector, upload zone, file summary, field mapping grid, preview table, issue tabs, and import actions are visible.
- Error / warning / suggestion tabs are clickable without JavaScript errors.
- Layout matches the selected direction: work-focused Excel import surface, dense table preview, right-side import checks, restrained teal accent.
- Existing logic tests pass with `node tests/run.mjs`.

Console:
- No runtime errors.
- Existing Tailwind CDN production warning is present elsewhere in the app and not introduced by this view.

Final result: passed

---

# Design QA: 定额库工作台

Reference: ImageGen quota workbench mockup, "定额库 / 价格基础 · 企业定额管理".

Prototype URL: http://localhost:8000/app/

Captured screenshot: `output/quota-workbench.png`

Checks:
- 定额库 page uses a workbench layout with header actions, search/filter row, KPI cards, quota table, right-side detail inspector, and bottom reminder panels.
- The table columns match the target: 分类, 清单名称, 项目特征, 单位, 综合单价(元), 状态.
- Selecting rows updates the right-side inspector.
- 编辑定额 opens the existing editable form in a modal.
- 复制 creates a modal draft whose name ends with “副本”.
- 搜索 and 价格状态筛选 update the list without runtime errors.
- Existing logic tests pass with `node tests/run.mjs`.

Console:
- No runtime errors during quota page interaction.

Final result: passed
