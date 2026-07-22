export const setStatusLine = (
  ctx: { ui?: { setStatus?: (key: string, text: string | undefined) => void } },
  text: string,
): void => {
  ctx.ui?.setStatus?.('router', text)
}
