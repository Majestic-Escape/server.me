export function parseMDYToUTC(from, to) {
  if (!from) return null;
  function sliceDate(dateStr) {
    const str = String(dateStr).trim();
    // ISO calendar dates ("2026-08-20" or "2026-08-20T00:00:00.000Z") are
    // accepted too: the admin Analytics page sends them, and every date
    // filter is a calendar day, never an instant.
    const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
    if (iso) {
      const [, y, m, d] = iso.map(Number);
      if (!m || !d || !y) throw new Error("Invalid date parts");
      return { year: y, month: m, day: d };
    }
    const parts = str.split("/");
    if (parts.length !== 3)
      throw new Error("Invalid date format. Expected M/D/YYYY");
    const [m, d, y] = parts.map(Number);
    if (!m || !d || !y) throw new Error("Invalid date parts");
    return { year: y, month: m, day: d };
  }
  const fromDate = sliceDate(from);
  if (!to) {
    // Only checkin given → use full single day
    return {
      from: new Date(
        Date.UTC(fromDate.year, fromDate.month - 1, fromDate.day, 0, 0, 0)
      ),
      to: new Date(
        Date.UTC(fromDate.year, fromDate.month - 1, fromDate.day, 23, 59, 59)
      ),
    };
  }
  const toDate = sliceDate(to);
  // returns a Date representing midnight UTC of that calendar date
  return {
    from: new Date(
      Date.UTC(fromDate.year, fromDate.month - 1, fromDate.day, 0, 0, 0)
    ),
    to: new Date(
      Date.UTC(toDate.year, toDate.month - 1, toDate.day, 23, 59, 59)
    ),
  };
}
export function parseMDYToUTCBooking(from, to) {
  if (!from) return null;
  function sliceDate(dateStr) {
    const parts = dateStr.split("/");
    if (parts.length !== 3)
      throw new Error("Invalid date format. Expected M/D/YYYY");
    const [m, d, y] = parts.map(Number);
    if (!m || !d || !y) throw new Error("Invalid date parts");
    return { year: y, month: m, day: d };
  }
  const fromDate = sliceDate(from);

  const toDate = sliceDate(to);
  // returns a Date representing midnight UTC of that calendar date
  return {
    from: new Date(
      Date.UTC(fromDate.year, fromDate.month - 1, fromDate.day, 0, 0, 0)
    ),
    to: new Date(Date.UTC(toDate.year, toDate.month - 1, toDate.day, 0, 0, 0)),
  };
}
