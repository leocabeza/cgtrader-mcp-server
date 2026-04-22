export type Image = {
  id?: number;
  url?: string;
  width?: number;
  height?: number;
};

export type File = {
  id: number;
  name?: string;
};

export type Model = {
  id: number;
  title?: string;
  author_name?: string;
  url?: string;
  category_id?: number;
  subcategory_id?: number;
  description?: string;
  tags?: string[];
  prices?: { download?: number };
  files?: File[];
  availableFileExtensions?: string[];
  thumbnails?: string[];
  animated?: boolean;
  rigged?: boolean;
  game_ready?: boolean;
  license?: string;
};

export type ViewModelResult = {
  model: Model;
  images: Image[];
};

export type DownloadEntry = {
  file_id: number;
  name?: string;
  extension?: string | null;
  download_url: string | null;
  error: string | null;
};

export type DownloadResult = {
  model_id: number;
  model_title?: string;
  count: number;
  files: DownloadEntry[];
  expires_hint?: string;
  agent_note?: string;
};
