"""Generate the importable XLSX example used by the ERP frontend."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

OUTPUT = Path(__file__).resolve().parents[1] / "web" / "purchase-order-template.xlsx"


def cell(value: object, column: str, row: int) -> str:
    if isinstance(value, int):
        return f'<c r="{column}{row}" t="n"><v>{value}</v></c>'
    escaped = (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
    return f'<c r="{column}{row}" t="inlineStr"><is><t>{escaped}</t></is></c>'


def main() -> None:
    headers = [
        "po_id",
        "supplier_name",
        "expected_date",
        "material_id",
        "material_name",
        "ordered_quantity",
        "unit",
    ]
    examples = [
        ["PO-20260930-001", "供應商範例", "2026-09-30", "MAT-1001", "控制晶片", 100, "pcs"],
        ["PO-20260930-001", "供應商範例", "2026-09-30", "MAT-1002", "鋁合金外殼", 50, "pcs"],
    ]
    rows = []
    for row_number, values in enumerate([headers, *examples], start=1):
        cells = "".join(
            cell(value, chr(ord("A") + index), row_number)
            for index, value in enumerate(values)
        )
        rows.append(f'<row r="{row_number}">{cells}</row>')

    files = {
        "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml"
 ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml"
 ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>""",
        "_rels/.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1"
 Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
 Target="xl/workbook.xml"/>
</Relationships>""",
        "xl/workbook.xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="採購單匯入範例" sheetId="1" r:id="rId1"/></sheets>
</workbook>""",
        "xl/_rels/workbook.xml.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1"
 Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
 Target="worksheets/sheet1.xml"/>
</Relationships>""",
        "xl/worksheets/sheet1.xml": f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:G{len(rows)}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>
<sheetData>{''.join(rows)}</sheetData>
</worksheet>""",
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(OUTPUT, "w", ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    main()
