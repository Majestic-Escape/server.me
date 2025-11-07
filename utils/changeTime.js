export function changeTime(num) {
  if (Number(num) > 12) {
    return `${Number(num) - 12} p.m.`;
  } else {
    return `${Number(num)} a.m.`;
  }
}
