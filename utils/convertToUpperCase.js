export function changeToUpperCase(data) {
  return data
    ?.trim()
    ?.split(" ")
    ?.map((item) => item.charAt(0).toUpperCase() + item.slice(1).toLowerCase())
    ?.join(" ");
}
