import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import {
  Container,
  fuzzyFilter,
  Input,
  type Component,
  Spacer,
  Text,
  getKeybindings,
} from '@earendil-works/pi-tui'
import { PROVIDER_NAME } from './constants.js'

export interface ModelOption {
  value: string   // "provider/model-id"
  label: string   // display name
  searchText: string  // what fuzzyFilter searches against
}

/**
 * Show fuzzy-searchable model selector.
 * Returns selected model ref ("provider/id") or undefined if cancelled.
 */
export async function showModelSelector(
  ctx: ExtensionCommandContext,
  options: ModelOption[],
  title?: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    const container = new Container()
    let filtered = options
    let selectedIndex = 0
    const maxVisible = 12

    // Search input
    const searchInput = new Input()
    searchInput.onSubmit = () => {
      const selected = filtered[selectedIndex]
      if (selected) done(selected.value)
    }

    // ── Build UI ────────────────────────────────────────────────
    container.addChild(new Text(
      theme.fg('accent', theme.bold(title ?? 'Pilih Model (ketik untuk mencari)')),
      0, 0,
    ))
    container.addChild(new Spacer(1))
    container.addChild(searchInput)
    container.addChild(new Spacer(1))

    // List container
    const listContainer = new Container()
    container.addChild(listContainer)

    container.addChild(new Spacer(1))
    container.addChild(new Text(
      theme.fg('dim', '↑↓ navigate • enter pilih • esc batal • ketik fuzzy search'),
      0, 0,
    ))

    // ── Filter & Render ─────────────────────────────────────────
    function filterModels(query: string): void {
      filtered = query
        ? fuzzyFilter(options, query, (o) => o.searchText)
        : options
      selectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1))
      renderList()
    }

    function renderList(): void {
      listContainer.clear()

      if (filtered.length === 0) {
        listContainer.addChild(new Text(theme.fg('muted', '  Tidak ada model yang cocok'), 0, 0))
        return
      }

      const startIdx = Math.max(0, Math.min(
        selectedIndex - Math.floor(maxVisible / 2),
        filtered.length - maxVisible,
      ))
      const endIdx = Math.min(startIdx + maxVisible, filtered.length)

      for (let i = startIdx; i < endIdx; i++) {
        const item = filtered[i]
        const isSelected = i === selectedIndex
        const label = isSelected
          ? theme.fg('accent', `→ ${item.label}`)
          : `  ${theme.fg('text', item.label)}`
        listContainer.addChild(new Text(label, 0, 0))
      }

      if (startIdx > 0 || endIdx < filtered.length) {
        listContainer.addChild(new Text(
          theme.fg('muted', `  (${selectedIndex + 1}/${filtered.length})`),
          0, 0,
        ))
      }
    }

    // ── Component ───────────────────────────────────────────────
    const component: Component = {
      render(width) { return container.render(width) },
      invalidate() { container.invalidate() },
      handleInput(data) {
        const kb = getKeybindings()

        if (kb.matches(data, 'tui.select.up')) {
          if (filtered.length === 0) return
          selectedIndex = selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1
          renderList()
          tui.requestRender()
        } else if (kb.matches(data, 'tui.select.down')) {
          if (filtered.length === 0) return
          selectedIndex = selectedIndex === filtered.length - 1 ? 0 : selectedIndex + 1
          renderList()
          tui.requestRender()
        } else if (kb.matches(data, 'tui.select.confirm')) {
          const selected = filtered[selectedIndex]
          if (selected) done(selected.value)
        } else if (kb.matches(data, 'tui.select.cancel')) {
          done(undefined)
        } else {
          searchInput.handleInput(data)
          filterModels(searchInput.getValue())
          tui.requestRender()
        }
      },
    }

    renderList()
    return component
  })
}

/**
 * Build model options from modelRegistry, filtering out router provider.
 */
export function buildModelOptions(registry: any): ModelOption[] {
  const models = registry?.getAvailable() ?? []

  return models
    .filter((m: any) => m.provider !== PROVIDER_NAME) // exclude router models
    .map((m: any) => {
      const ref = `${m.provider}/${m.id}`
      return {
        value: ref,
        label: ref,
        searchText: `${m.provider} ${m.id}`,
      }
    })
    .sort((a: ModelOption, b: ModelOption) => a.value.localeCompare(b.value))
}
