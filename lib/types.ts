export type HeaderPair = {
  name: string;
  value: string;
};

export type DnsOverride = {
  host: string;
  ip: string;
};

export type CheckRequest = {
  url: string;
  headers?: HeaderPair[];
  dnsOverride?: DnsOverride;
};

export type ResourceSummaryData = {
  links: string[];
  images: string[];
  stylesheets: string[];
  scripts: string[];
  iframes: string[];
  other: string[];
};

export type NetworkBodyEncoding = "text" | "base64" | "empty";

export type NetworkRequestEntry = {
  url: string;
  host: string;
  status: number;
  contentType: string;
  contentSize: number | null;
  resourceType: string;
  /** ISO-8601 timestamp when the response was observed */
  date: string;
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  /** How `body` should be interpreted in the Content tab */
  bodyEncoding: NetworkBodyEncoding;
  /** Plain text, base64 string, or empty when no body */
  body: string;
  /** True when body was truncated to the capture size limit */
  bodyTruncated: boolean;
};

export type CheckResponse = {
  finalUrl: string;
  status: number;
  title: string | null;
  html: string;
  screenshotBase64: string;
  resources: ResourceSummaryData;
  requestHeaders: HeaderPair[];
  responseHeaders: HeaderPair[];
  networkRequests: NetworkRequestEntry[];
  dnsOverride: DnsOverride | null;
  timingMs: number;
  error?: string;
};
