export interface Stub {
  url: string;
  port: number;
  puts: { bucket: string; key: string; size: number; type: string }[];
  close(): Promise<void>;
}
export function startStub(o: {
  root: string;
  keyId: string;
  secret: string;
  prefix?: string;
  port?: number;
  now?: () => number;
  log?: (msg: string) => void;
}): Promise<Stub>;
