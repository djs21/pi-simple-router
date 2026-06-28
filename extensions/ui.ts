export const setStatusLine = (
  ctx: { ui?: { setStatus?: (key: string, text: string | undefined) => void } },
  text: string,
): void => {
  ctx.ui?.setStatus?.('router', text)
}

export const formatFallbackNotification = (
  prevRef: string,
  nextRef: string,
): string => {
  return `\n⚠️ ${prevRef} gagal, fallback ke ${nextRef}\n`
}
