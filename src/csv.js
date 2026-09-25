'use strict';

// 极简 CSV：支持双引号包裹与 "" 转义
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch === '\r') {
      // skip
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function parseChairsCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  const hasHeader = header.slice(0, 2).some((h) => h.toLowerCase() === 'code' || h.toLowerCase() === '编码');
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const idx = (names) => {
    for (const n of names) {
      const i = header.findIndex((h) => names.includes(h.toLowerCase()));
      if (i >= 0) return i;
    }
    return -1;
  };
  const codeI = hasHeader ? idx(['code', '编码', '编号']) : 0;
  const labelI = hasHeader ? idx(['label', '名称', '标签']) : 1;
  const statusI = hasHeader ? idx(['status', '状态']) : 2;
  const verificationI = hasHeader ? idx(['verification', '核验']) : 3;
  return dataRows.map((r) => ({
    code: (r[codeI >= 0 ? codeI : 0] || '').trim(),
    label: (r[labelI >= 0 ? labelI : 1] || '').trim(),
    status: (r[statusI >= 0 ? statusI : 2] || '').trim(),
    verification: (r[verificationI >= 0 ? verificationI : 3] || '').trim()
  }));
}

function escapeCsv(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function chairsToCsv(rows) {
  const header = ['code', 'label', 'status', 'verification', 'seatId', 'createdAt'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(header.map((h) => escapeCsv(r[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = { parseCsv, parseChairsCsv, chairsToCsv, escapeCsv };
