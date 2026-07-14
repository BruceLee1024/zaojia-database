// Shared Material Symbols vocabulary. Keep icon choices semantic so screens do
// not gradually introduce near-duplicate glyphs for the same user action.
export const ICONS = Object.freeze({
  navigation: Object.freeze({
    overview: 'dashboard',
    import: 'upload_file',
    quota: 'menu_book',
    boqLibrary: 'format_list_bulleted',
    projects: 'folder_managed',
    boq: 'list_alt',
    indicators: 'analytics',
    experience: 'psychology_alt',
    settings: 'settings',
  }),
  action: Object.freeze({
    add: 'add',
    import: 'upload',
    export: 'download',
    edit: 'edit',
    copy: 'content_copy',
    remove: 'delete',
    search: 'search',
    filter: 'filter_alt',
    clearFilter: 'filter_alt_off',
    back: 'arrow_back',
    close: 'close',
    save: 'save',
    apply: 'playlist_add',
  }),
  resource: Object.freeze({
    quota: 'menu_book',
    boq: 'format_list_bulleted',
    project: 'folder_managed',
    ai: 'auto_awesome',
    backup: 'cloud_upload',
  }),
  status: Object.freeze({
    success: 'check_circle',
    warning: 'warning',
    error: 'error',
    info: 'info',
  }),
});

export const ICON_TONES = Object.freeze({
  primary: 'teal',
  info: 'blue',
  warning: 'amber',
  danger: 'red',
  neutral: 'slate',
});

export function getIcon(group, name, fallback = 'help') {
  return ICONS[group]?.[name] || fallback;
}
