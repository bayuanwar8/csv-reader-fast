// csv-reader-fast: a faster drop-in for csv-reader 1.0.0.
//
// It answers exactly what csv-reader 1.0.0 answers for every input {text, header}:
// {columns, rows, errors} under the same broken-row policy (BOM dropped, records end
// at LF/CRLF, blank lines are no records, stray CRs dropped, quoted fields run to the
// next undoubled quote with "" as one quote and CR/CRLF inside as LF, junk after a
// closing quote appended, an unclosed quote read again as unquoted, short/long rows
// padded/cut to the first record's width, errors {code, line, row} in the order met).
//
// Speed comes from two tiers. Most records are clean: no quote, no stray CR. Those
// go through a fast path built only on native string operations (indexOf to find the
// line, slice + split(',') for the fields) and never touch the text one character at
// a time. Anything with a quote — quoted fields, fields spanning lines, junk after a
// closing quote, an unclosed quote — or a stray CR goes through a slow path that
// walks the record with indexOf jumps (next comma / line break / quote) instead of a
// per-character loop, while keeping every error and line count identical to the
// reference. The slow path only ever runs on the small minority of records that need
// it, so the common case stays in native code.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

const LF = 10; // '\n'
const CR = 13; // '\r'
const COMMA = 44; // ','
const QUOTE = 34; // '"'

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1; // a U+FEFF at the very start is dropped

  // The record being read: the line it starts on and the index in rows it takes
  // (null: the header). Every error raised while reading it uses these two.
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `value` up to the next comma or line break. A CR
  // not followed by LF is dropped (stray_cr). Returns the field, how it ended, and
  // `added`, the characters kept (a caller uses it to spot quote junk). The CR check
  // stays inside the field's own segment, so a file whose next CR is far away never
  // makes this scan past the field.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      const comma = text.indexOf(',', pos);
      const lf = text.indexOf('\n', pos);
      let end = -1;
      let commaEnds = false;
      if (comma !== -1 && (lf === -1 || comma < lf)) {
        end = comma;
        commaEnds = true;
      } else if (lf !== -1) {
        end = lf;
      }
      const segEnd = end === -1 ? len : end;
      const seg = text.slice(pos, segEnd);
      const cr = seg.indexOf('\r');
      if (cr === -1) {
        if (seg.length > 0) {
          value += seg;
          added += seg.length;
        }
        if (end === -1) {
          pos = len;
          return { value, ended: 'end', added };
        }
        if (commaEnds) {
          pos = end + 1;
          return { value, ended: 'comma', added };
        }
        pos = end + 1;
        line += 1;
        return { value, ended: 'line', added };
      }
      // A CR sits inside this field's segment.
      const crPos = pos + cr;
      if (text.charCodeAt(crPos + 1) === LF) {
        // CRLF ends the field here.
        if (cr > 0) {
          value += seg.slice(0, cr);
          added += cr;
        }
        pos = crPos + 2;
        line += 1;
        return { value, ended: 'line', added };
      }
      // A stray CR: dropped, the field goes on after it.
      if (cr > 0) {
        value += seg.slice(0, cr);
        added += cr;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = crPos + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. The next quote is found with
  // indexOf, so the text between quotes is taken as a whole chunk: a chunk with no
  // line break is appended as it stands, and one with CRs or LFs has each CRLF or
  // lone CR turned into one LF while the line count moves by the same number.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it
        // is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      const chunk = text.slice(pos, q);
      if (chunk.indexOf('\r') === -1) {
        if (chunk.indexOf('\n') === -1) {
          value += chunk;
        } else {
          line += (chunk.match(/\n/g) || []).length;
          value += chunk;
        }
      } else {
        line += (chunk.match(/\r\n|\r|\n/g) || []).length;
        value += chunk.replace(/\r\n?/g, '\n');
      }
      if (text.charCodeAt(q + 1) === QUOTE) {
        // A doubled quote is one quote inside the field.
        value += '"';
        pos = q + 2;
        continue;
      }
      // The closing quote.
      pos = q + 1;
      if (pos >= len) return { value, ended: 'end' };
      const c = text.charCodeAt(pos);
      if (c === COMMA) {
        pos += 1;
        return { value, ended: 'comma' };
      }
      if (c === LF) {
        pos += 1;
        line += 1;
        return { value, ended: 'line' };
      }
      if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
        return { value, ended: 'line' };
      }
      // What follows the closing quote is appended as it stands, up to the next
      // comma or line break.
      const junk = readUnquoted(value);
      if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return junk;
    }
  }

  // Reads one record from pos, field by field, exactly as the reference does.
  // Returns its fields, or null when the line held only stray CRs (no record; its
  // stray_cr errors stay). Updates pos and line past the record's line break.
  function parseRecordSlow() {
    const fields = [];
    let quoted = false;
    let ended;
    do {
      quoted = text.charCodeAt(pos) === QUOTE;
      const field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
      ended = field.ended;
    } while (ended === 'comma');
    if (fields.length === 1 && fields[0] === '' && !quoted) return null;
    return fields;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // The record's first line, [pos, lineEnd). A quote or a stray CR anywhere in it
    // sends the record to the slow path; a clean line takes the fast path.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    let end = lineEnd;
    let slow = false;
    if (nl !== -1) {
      // A CR right before the LF is the CRLF line break, not part of a field.
      if (lineEnd > pos && text.charCodeAt(lineEnd - 1) === CR) end = lineEnd - 1;
    } else if (lineEnd > pos && text.charCodeAt(lineEnd - 1) === CR) {
      // The text ends on a lone CR: a stray CR at the end of the last field.
      slow = true;
    }
    let fields;
    if (!slow) {
      const seg = text.slice(pos, end);
      if (seg.indexOf('"') !== -1 || seg.indexOf('\r') !== -1) {
        slow = true;
      } else {
        fields = seg.split(',');
        pos = nl === -1 ? len : nl + 1;
        if (nl !== -1) line += 1;
        // A single empty field cannot be a real record here (blank lines are
        // skipped above); this guards the only-stray-CRs shape all the same.
        if (fields.length === 1 && fields[0] === '') continue;
      }
    }
    if (slow) {
      fields = parseRecordSlow();
      if (fields === null) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
