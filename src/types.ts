export interface CGTraderPrices {
  download: number;
}

export interface CGTraderFile {
  id: number;
  name: string;
  size?: number;
  download_url?: string;
}

export interface CGTraderThumbnail {
  url?: string;
  width?: number;
  height?: number;
}

export interface CGTraderModel {
  id: number;
  status?: string;
  author_name?: string;
  url?: string;
  slug?: string;
  category_id?: number;
  subcategory_id?: number;
  title?: string;
  downloadable?: boolean;
  description?: string;
  animated?: boolean;
  rigged?: boolean;
  game_ready?: boolean;
  type?: string;
  license?: string;
  tags?: string[];
  prices?: CGTraderPrices;
  files?: CGTraderFile[];
  availableFileExtensions?: string[];
  thumbnails?: CGTraderThumbnail[];
  [key: string]: unknown;
}

export interface CGTraderModelListResponse {
  total: number;
  models: CGTraderModel[];
}

export interface CGTraderCategory {
  id: number;
  name?: string;
  slug?: string;
  parent_id?: number | null;
  description?: string;
  [key: string]: unknown;
}

export interface CGTraderImage {
  id: number;
  url?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface CGTraderLicense {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}
