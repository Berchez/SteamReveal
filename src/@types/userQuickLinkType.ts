export interface QuickLink {
  /** Stable identifier, used as the key and for conditional logic (e.g. 'faceit'). */
  id: string;
  title: string;
  /** Emoji/abbreviation displayed as a fallback if the image fails to load. */
  icon: string;
  iconUrl?: string;
  /** Always a function—even Faceit has a predictable fallback URL. */
  getUrl: (steamId: string) => string;
  /** Marks links whose actual URL depends on an asynchronous request (e.g. Faceit). */
  isDynamic?: boolean;
}
