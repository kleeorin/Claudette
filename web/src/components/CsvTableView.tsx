import { useMemo, useState, useCallback } from 'react'
import DataGrid, { textEditor, type Column } from 'react-data-grid'
import Papa from 'papaparse'
import 'react-data-grid/lib/styles.css'

// A dedicated table view for CSV/TSV files. Cells are edited in place (double-click
// or start typing), and every change is serialized straight back to CSV text and
// pushed through onChange — so it plugs into FileEditorView's existing dirty/save
// flow with no special-casing on the save side.
//
// It uses a spreadsheet model on purpose: columns are labelled A, B, C… and *every*
// row is data (including what may look like a header). That avoids guessing whether
// row 0 is a header and keeps every cell — header included — editable.
interface Props {
  initialText: string
  filename: string
  readOnly: boolean
  onChange: (text: string) => void
}

type Row = { __id: number; [col: string]: string | number }

// 0 -> "A", 25 -> "Z", 26 -> "AA" … spreadsheet-style column labels.
function colLabel(i: number): string {
  let s = ''
  i += 1
  while (i > 0) {
    const r = (i - 1) % 26
    s = String.fromCharCode(65 + r) + s
    i = Math.floor((i - 1) / 26)
  }
  return s
}

// Serialize the grid (array-of-arrays) back to CSV/TSV text.
function serialize(matrix: string[][], delimiter: string): string {
  return Papa.unparse(matrix, { delimiter, newline: '\n' })
}

export function CsvTableView({ initialText, filename, readOnly, onChange }: Props) {
  const delimiter = /\.tsv$/i.test(filename) ? '\t' : ','

  // Parse once for this mount. FileEditorView remounts us via key={path} per file,
  // so we don't need to re-parse on prop changes.
  const parsed = useMemo(() => {
    const res = Papa.parse<string[]>(initialText, {
      delimiter,
      skipEmptyLines: false,
      // Keep everything as raw strings — no type coercion, so round-tripping is lossless.
    })
    const matrix = (res.data as unknown as string[][]).filter(Array.isArray)
    // Guarantee at least a 1×1 editable surface for empty files.
    if (matrix.length === 0) matrix.push([''])
    const cols = Math.max(1, ...matrix.map((r) => r.length))
    // Pad every row to the same width so the grid is rectangular.
    for (const r of matrix) while (r.length < cols) r.push('')
    return { matrix, cols }
  }, [initialText, delimiter])

  const [colCount, setColCount] = useState(parsed.cols)
  const [rows, setRows] = useState<Row[]>(() =>
    parsed.matrix.map((r, i) => {
      const row: Row = { __id: i }
      r.forEach((v, c) => { row[String(c)] = v })
      return row
    }),
  )

  const rowsToText = useCallback((rs: Row[], cols: number): string => {
    const matrix = rs.map((row) => {
      const arr: string[] = []
      for (let c = 0; c < cols; c++) arr.push(String(row[String(c)] ?? ''))
      return arr
    })
    return serialize(matrix, delimiter)
  }, [delimiter])

  const columns = useMemo<Column<Row>[]>(() => {
    const idxCol: Column<Row> = {
      key: '__row',
      name: '',
      width: 52,
      minWidth: 40,
      frozen: true,
      resizable: false,
      cellClass: 'rdg-row-index',
      renderCell: ({ row }) => <span className="text-ctp-overlay">{row.__id + 1}</span>,
    }
    const dataCols: Column<Row>[] = Array.from({ length: colCount }, (_, c) => ({
      key: String(c),
      name: colLabel(c),
      resizable: true,
      editable: !readOnly,
      renderEditCell: readOnly ? undefined : textEditor,
    }))
    return [idxCol, ...dataCols]
  }, [colCount, readOnly])

  const onRowsChange = useCallback((newRows: Row[]) => {
    setRows(newRows)
    onChange(rowsToText(newRows, colCount))
  }, [onChange, rowsToText, colCount])

  const addRow = useCallback(() => {
    setRows((rs) => {
      const row: Row = { __id: rs.length }
      for (let c = 0; c < colCount; c++) row[String(c)] = ''
      const next = [...rs, row]
      onChange(rowsToText(next, colCount))
      return next
    })
  }, [colCount, onChange, rowsToText])

  const addColumn = useCallback(() => {
    const next = colCount + 1
    setColCount(next)
    setRows((rs) => {
      const nextRows = rs.map((r) => ({ ...r, [String(colCount)]: '' }))
      onChange(rowsToText(nextRows, next))
      return nextRows
    })
  }, [colCount, onChange, rowsToText])

  return (
    <div className="flex flex-col h-full">
      {!readOnly && (
        <div className="h-8 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
          <span className="text-[10px] text-ctp-overlay mr-auto">
            {rows.length} rows × {colCount} cols · double-click a cell to edit
          </span>
          <button
            onClick={addRow}
            className="text-[11px] px-2 py-0.5 rounded bg-ctp-surface0 text-ctp-subtext hover:bg-ctp-surface1 transition"
          >+ Row</button>
          <button
            onClick={addColumn}
            className="text-[11px] px-2 py-0.5 rounded bg-ctp-surface0 text-ctp-subtext hover:bg-ctp-surface1 transition"
          >+ Column</button>
        </div>
      )}
      <div className="flex-1 min-h-0 claudette-rdg">
        <DataGrid
          columns={columns}
          rows={rows}
          onRowsChange={onRowsChange}
          rowKeyGetter={(r) => r.__id}
          className="rdg-dark"
          style={{ height: '100%' }}
        />
      </div>
    </div>
  )
}
