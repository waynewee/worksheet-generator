import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.trim();
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
const ASSET_BUCKET =
  import.meta.env.VITE_SUPABASE_ASSET_BUCKET?.trim() || "worksheet-assets";
const SESSION_STORAGE_KEY = "worksheet-generator-cloud-session-v1";
const SESSION_HEADER = "x-app-session";
const MAX_ASSET_DIMENSION = 1600;
const ASSET_TABLE = "assets";
const WORKSHEET_TABLE = "worksheets";

type AccountRpcRow = {
  account_id: string;
  username: string;
  session_token?: string;
};

type AssetRow = {
  id: string;
  name: string;
  public_url: string;
  width: number;
  height: number;
  byte_size: number | null;
  storage_path: string;
  content_hash: string;
  created_at: string;
};

type WorksheetRow = {
  id: string;
  name: string;
  layout: {
    items?: unknown[];
    groups?: unknown[];
  } | null;
  item_count: number | null;
  created_at: string;
  updated_at: string;
};

export type CloudAssetRecord = {
  id: string;
  name: string;
  dataUrl: string;
  width: number;
  height: number;
  createdAt: number;
  byteSize: number | null;
  storagePath: string;
  contentHash: string;
};

export type CloudWorksheetSummary = {
  id: string;
  name: string;
  itemCount: number;
  createdAt: number;
  updatedAt: number;
};

export type CloudWorksheetRecord = CloudWorksheetSummary & {
  layout: {
    items?: unknown[];
    groups?: unknown[];
  } | null;
};

export type CloudAccount = {
  accountId: string;
  username: string;
};

export type CloudAccountSession = CloudAccount & {
  sessionToken: string;
};

type SaveWorksheetInput = {
  id?: string;
  name: string;
  items: unknown[];
  groups: unknown[];
};

let cachedClient: SupabaseClient | null | undefined;
let currentSessionToken = readStoredSession()?.sessionToken ?? null;

function readStoredSession(): CloudAccountSession | null {
  if (typeof window === "undefined") {
    return null;
  }

  const rawValue = window.localStorage.getItem(SESSION_STORAGE_KEY);

  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<CloudAccountSession>;

    if (
      typeof parsed.accountId !== "string" ||
      typeof parsed.username !== "string" ||
      typeof parsed.sessionToken !== "string"
    ) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }

    return {
      accountId: parsed.accountId,
      username: parsed.username,
      sessionToken: parsed.sessionToken,
    };
  } catch {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
}

function writeStoredSession(session: CloudAccountSession | null) {
  currentSessionToken = session?.sessionToken ?? null;
  cachedClient = undefined;

  if (typeof window === "undefined") {
    return;
  }

  if (!session) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

function requireSession() {
  const session = readStoredSession();

  if (!session) {
    throw new Error("Sign in to access cloud saves");
  }

  return session;
}

function mapAccountSession(row: AccountRpcRow): CloudAccountSession {
  return {
    accountId: row.account_id,
    username: row.username,
    sessionToken: String(row.session_token ?? ""),
  };
}

function mapAccount(row: AccountRpcRow): CloudAccount {
  return {
    accountId: row.account_id,
    username: row.username,
  };
}

function getClient() {
  if (cachedClient !== undefined) {
    return cachedClient;
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    cachedClient = null;
    return cachedClient;
  }

  cachedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: currentSessionToken
        ? { [SESSION_HEADER]: currentSessionToken }
        : {},
    },
  });

  return cachedClient;
}

function requireClient() {
  const client = getClient();

  if (!client) {
    throw new Error("Cloud persistence is not configured");
  }

  return client;
}

function toTimestamp(value: string) {
  return new Date(value).getTime();
}

async function createSignedAssetUrl(
  client: SupabaseClient,
  storagePath: string,
) {
  const { data, error } = await client.storage
    .from(ASSET_BUCKET)
    .createSignedUrl(storagePath, 60 * 60 * 24 * 14);

  if (error) {
    throw error;
  }

  return data.signedUrl;
}

async function mapAssetRow(client: SupabaseClient, row: AssetRow) {
  const signedUrl = await createSignedAssetUrl(client, row.storage_path);

  return {
    id: row.id,
    name: row.name,
    dataUrl: signedUrl,
    width: row.width,
    height: row.height,
    createdAt: toTimestamp(row.created_at),
    byteSize: row.byte_size,
    storagePath: row.storage_path,
    contentHash: row.content_hash,
  };
}

function mapWorksheetRow(row: WorksheetRow): CloudWorksheetRecord {
  return {
    id: row.id,
    name: row.name,
    itemCount: row.item_count ?? row.layout?.items?.length ?? 0,
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
    layout: row.layout,
  };
}

function sanitizeFileName(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "asset"
  );
}

function extensionForMimeType(mimeType: string) {
  if (mimeType === "image/svg+xml") {
    return "svg";
  }

  if (mimeType === "image/gif") {
    return "gif";
  }

  if (mimeType === "image/png") {
    return "png";
  }

  if (mimeType === "image/webp") {
    return "webp";
  }

  return "jpg";
}

async function hashBlob(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image"));
    image.src = url;
  });
}

async function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

async function createOptimizedBlob(file: File) {
  if (file.type === "image/svg+xml" || file.type === "image/gif") {
    const sourceUrl = URL.createObjectURL(file);

    try {
      const image = await loadImage(sourceUrl);

      return {
        blob: file,
        width: image.naturalWidth,
        height: image.naturalHeight,
        mimeType: file.type,
      };
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
  }

  const sourceUrl = URL.createObjectURL(file);

  try {
    const image = await loadImage(sourceUrl);
    const scale = Math.min(
      1,
      MAX_ASSET_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");

    if (!context) {
      return {
        blob: file,
        width: image.naturalWidth,
        height: image.naturalHeight,
        mimeType: file.type || "image/png",
      };
    }

    context.drawImage(image, 0, 0, width, height);

    const optimizedBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Failed to encode image"));
            return;
          }

          resolve(blob);
        },
        "image/webp",
        0.82,
      );
    });

    if (optimizedBlob.size >= file.size) {
      return {
        blob: file,
        width: image.naturalWidth,
        height: image.naturalHeight,
        mimeType: file.type || "image/png",
      };
    }

    return {
      blob: optimizedBlob,
      width,
      height,
      mimeType: optimizedBlob.type || "image/webp",
    };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

export function isCloudPersistenceEnabled() {
  return Boolean(getClient());
}

export function getCloudPersistenceConfig() {
  return {
    enabled: isCloudPersistenceEnabled(),
    assetBucket: ASSET_BUCKET,
  };
}

export function getStoredCloudAccountSession() {
  return readStoredSession();
}

export function clearStoredCloudAccountSession() {
  writeStoredSession(null);
}

export async function getCurrentCloudAccount() {
  if (!currentSessionToken) {
    return null;
  }

  const client = requireClient();
  const { data, error } = await client.rpc("get_current_account").maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  return mapAccount(data as AccountRpcRow);
}

export async function signUpCloudAccount(username: string, password: string) {
  const client = requireClient();
  const { data, error } = await client
    .rpc("sign_up_account", {
      username_input: username,
      password_input: password,
    })
    .single();

  if (error) {
    throw error;
  }

  const session = mapAccountSession(data as AccountRpcRow);
  writeStoredSession(session);
  return session;
}

export async function signInCloudAccount(username: string, password: string) {
  const client = requireClient();
  const { data, error } = await client
    .rpc("sign_in_account", {
      username_input: username,
      password_input: password,
    })
    .single();

  if (error) {
    throw error;
  }

  const session = mapAccountSession(data as AccountRpcRow);
  writeStoredSession(session);
  return session;
}

export async function signOutCloudAccount() {
  if (!currentSessionToken) {
    clearStoredCloudAccountSession();
    return;
  }

  const client = requireClient();
  const { error } = await client.rpc("sign_out_account");

  clearStoredCloudAccountSession();

  if (error) {
    throw error;
  }
}

export async function listCloudAssets() {
  const client = requireClient();
  const { data, error } = await client
    .from(ASSET_TABLE)
    .select(
      "id, name, public_url, width, height, byte_size, storage_path, content_hash, created_at",
    )
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return Promise.all(
    (data ?? []).map((row) => mapAssetRow(client, row as AssetRow)),
  );
}

export async function uploadCloudAsset(file: File) {
  const client = requireClient();
  const session = requireSession();
  const optimized = await createOptimizedBlob(file);
  const contentHash = await hashBlob(optimized.blob);
  const { data: existingAsset, error: existingError } = await client
    .from(ASSET_TABLE)
    .select(
      "id, name, public_url, width, height, byte_size, storage_path, content_hash, created_at",
    )
    .eq("content_hash", contentHash)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  if (existingAsset) {
    return mapAssetRow(client, existingAsset as AssetRow);
  }

  const assetId = crypto.randomUUID();
  const extension = extensionForMimeType(optimized.mimeType);
  const storagePath = `${session.accountId}/${contentHash}-${sanitizeFileName(file.name)}.${extension}`;
  const { error: uploadError } = await client.storage
    .from(ASSET_BUCKET)
    .upload(storagePath, optimized.blob, {
      cacheControl: "31536000",
      contentType: optimized.mimeType,
      upsert: false,
    });

  if (uploadError) {
    throw uploadError;
  }

  const row = {
    id: assetId,
    owner_account_id: session.accountId,
    name: file.name,
    public_url: storagePath,
    width: optimized.width,
    height: optimized.height,
    byte_size: optimized.blob.size,
    storage_path: storagePath,
    content_hash: contentHash,
  };

  const { data, error } = await client
    .from(ASSET_TABLE)
    .insert(row)
    .select(
      "id, name, public_url, width, height, byte_size, storage_path, content_hash, created_at",
    )
    .single();

  if (error) {
    await client.storage.from(ASSET_BUCKET).remove([storagePath]);
    throw error;
  }

  return mapAssetRow(client, data as AssetRow);
}

export async function deleteCloudAsset(assetId: string) {
  const client = requireClient();
  const { data, error } = await client
    .from(ASSET_TABLE)
    .select("storage_path")
    .eq("id", assetId)
    .single();

  if (error) {
    throw error;
  }

  const storagePath = String(data.storage_path ?? "");

  if (storagePath) {
    const { error: storageError } = await client.storage
      .from(ASSET_BUCKET)
      .remove([storagePath]);

    if (storageError) {
      throw storageError;
    }
  }

  const { error: deleteError } = await client
    .from(ASSET_TABLE)
    .delete()
    .eq("id", assetId);

  if (deleteError) {
    throw deleteError;
  }
}

export async function listCloudWorksheets() {
  const client = requireClient();
  const { data, error } = await client
    .from(WORKSHEET_TABLE)
    .select("id, name, item_count, created_at, updated_at")
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) =>
    mapWorksheetRow({ ...(row as WorksheetRow), layout: null }),
  );
}

export async function loadCloudWorksheet(id: string) {
  const client = requireClient();
  const { data, error } = await client
    .from(WORKSHEET_TABLE)
    .select("id, name, layout, item_count, created_at, updated_at")
    .eq("id", id)
    .single();

  if (error) {
    throw error;
  }

  return mapWorksheetRow(data as WorksheetRow);
}

export async function saveCloudWorksheet(input: SaveWorksheetInput) {
  const client = requireClient();
  const session = requireSession();
  const payload = {
    owner_account_id: session.accountId,
    name: input.name.trim(),
    layout: {
      items: input.items,
      groups: input.groups,
    },
    item_count: input.items.length,
    updated_at: new Date().toISOString(),
  };

  if (input.id) {
    const { data, error } = await client
      .from(WORKSHEET_TABLE)
      .update(payload)
      .eq("id", input.id)
      .select("id, name, layout, item_count, created_at, updated_at")
      .single();

    if (error) {
      throw error;
    }

    return mapWorksheetRow(data as WorksheetRow);
  }

  const { data, error } = await client
    .from(WORKSHEET_TABLE)
    .insert({
      ...payload,
      created_at: new Date().toISOString(),
    })
    .select("id, name, layout, item_count, created_at, updated_at")
    .single();

  if (error) {
    throw error;
  }

  return mapWorksheetRow(data as WorksheetRow);
}

export async function deleteCloudWorksheet(id: string) {
  const client = requireClient();
  const { error } = await client.from(WORKSHEET_TABLE).delete().eq("id", id);

  if (error) {
    throw error;
  }
}

export async function getRemoteImagePreview(url: string) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Failed to fetch image preview");
  }

  const blob = await response.blob();
  return blobToDataUrl(blob);
}
