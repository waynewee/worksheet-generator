import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import {
  loadAssets,
  removeAsset,
  saveAsset,
  type StoredAsset,
} from "./lib/assetsDb";
import {
  clearStoredCloudAccountSession,
  deleteCloudAsset,
  deleteCloudWorksheet,
  getCurrentCloudAccount,
  getCloudPersistenceConfig,
  getStoredCloudAccountSession,
  isCloudPersistenceEnabled,
  listCloudAssets,
  listCloudWorksheets,
  loadCloudWorksheet,
  saveCloudWorksheet,
  signInCloudAccount,
  signOutCloudAccount,
  signUpCloudAccount,
  uploadCloudAsset,
  type CloudAccount,
  type CloudAssetRecord,
  type CloudWorksheetSummary,
} from "./lib/cloudPersistence";

type NumberInputProps = {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onCommit: (value: number) => void;
};

type ColorInputProps = {
  value: string;
  label: string;
  onChange: (value: string) => void;
};

type ShapeType = "rectangle" | "square" | "circle" | "oval" | "triangle";
type BoxType = "text" | "number";
type TextBorderStyle = "solid" | "dashed" | "dotted" | "none";
type ResizeHandle = "nw" | "ne" | "sw" | "se";

type BaseItem = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};

type ShapeItem = BaseItem & {
  kind: "shape";
  shapeType: ShapeType;
  fill: string;
  stroke: string;
  strokeWidth: number;
};

type TextItem = BaseItem & {
  kind: "text";
  boxType: BoxType;
  content: string;
  fontSize: number;
  align: "left" | "center" | "right";
  textColor: string;
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
  borderStyle: TextBorderStyle;
};

type AssetItem = BaseItem & {
  kind: "asset";
  assetId: string;
  assetName: string;
  src: string;
  fit: "contain" | "cover";
};

type EditorItem = ShapeItem | TextItem | AssetItem;

type ItemGroup = {
  id: string;
  itemIds: string[];
};

type DragState = {
  itemIds: string[];
  mode: "move" | "resize";
  handle?: ResizeHandle;
  startX: number;
  startY: number;
  origins: Record<
    string,
    {
      x: number;
      y: number;
      width: number;
      height: number;
    }
  >;
};

const USERNAME_REQUIREMENTS_MESSAGE =
  "Username must be 3-30 characters and use only letters, numbers, dots, hyphens, or underscores";
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]*[a-z0-9]$/i;

type ClipboardState = {
  items: EditorItem[];
  mode: "copy" | "cut";
  group: ItemGroup | null;
};

type ContextMenuState = {
  x: number;
  y: number;
  scope: "stage" | "item" | "selection" | "group";
  itemId: string | null;
  targetIds: string[];
  groupId: string | null;
  canvasX: number | null;
  canvasY: number | null;
};

type SelectionMarquee = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  baseSelectionIds: string[];
};

type StoredLayout = {
  items: EditorItem[];
  groups: ItemGroup[];
};

type LibraryAsset = StoredAsset | CloudAssetRecord;

type LayerMoveDirection = "forward" | "backward" | "front" | "back";

const PAGE_WIDTH = 794;
const PAGE_HEIGHT = 1123;
const STORAGE_KEY = "worksheet-generator-layout-v1";
const CONTEXT_MENU_WIDTH = 220;
const CONTEXT_MENU_HEIGHT = 360;

function createId() {
  return crypto.randomUUID();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function round(value: number) {
  return Math.round(value);
}

function NumberInput({
  value,
  min,
  max,
  step = 1,
  onCommit,
}: NumberInputProps) {
  const [draftValue, setDraftValue] = useState(String(value));

  useEffect(() => {
    setDraftValue(String(value));
  }, [value]);

  function commit(nextValue: string) {
    const trimmed = nextValue.trim();

    if (!trimmed) {
      setDraftValue(String(value));
      return;
    }

    const parsedValue = Number(trimmed);

    if (Number.isNaN(parsedValue)) {
      setDraftValue(String(value));
      return;
    }

    let committedValue = parsedValue;

    if (typeof min === "number") {
      committedValue = Math.max(committedValue, min);
    }

    if (typeof max === "number") {
      committedValue = Math.min(committedValue, max);
    }

    onCommit(committedValue);
    setDraftValue(String(committedValue));
  }

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draftValue}
      onChange={(event) => setDraftValue(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }

        if (event.key === "Escape") {
          setDraftValue(String(value));
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function ColorInput({ value, label, onChange }: ColorInputProps) {
  const pickerRef = useRef<HTMLInputElement>(null);

  function openPicker() {
    const picker = pickerRef.current;

    if (!picker) {
      return;
    }

    if (typeof picker.showPicker === "function") {
      picker.showPicker();
      return;
    }

    picker.click();
  }

  return (
    <div className="color-input-control">
      <span
        className="color-input-swatch"
        style={{ backgroundColor: value }}
        aria-hidden="true"
      />
      <input
        className="color-input-trigger"
        type="text"
        value={value.toUpperCase()}
        readOnly
        aria-label={label}
        onClick={openPicker}
        onFocus={openPicker}
      />
      <input
        ref={pickerRef}
        className="color-input-native"
        type="color"
        tabIndex={-1}
        aria-hidden="true"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function getMinSize(item: EditorItem) {
  if (item.kind === "asset") {
    return { width: 64, height: 64 };
  }

  if (item.kind === "shape") {
    return { width: 2, height: 2 };
  }

  return { width: 96, height: 52 };
}
function normalizeShapeItem(item: ShapeItem): ShapeItem {
  return item;
}

function getDefaultTextBoxAppearance(boxType: BoxType) {
  if (boxType === "number") {
    return {
      textColor: "#1f3a2a",
      backgroundColor: "#f0f7f1",
      borderColor: "#7fb49b",
      borderWidth: 2,
      borderStyle: "solid" as const,
    };
  }

  return {
    textColor: "#2d241d",
    backgroundColor: "#ffffff",
    borderColor: "#b7a89a",
    borderWidth: 2,
    borderStyle: "dashed" as const,
  };
}

function normalizeTextItem(item: TextItem): TextItem {
  const defaults = getDefaultTextBoxAppearance(item.boxType);

  return {
    ...item,
    textColor: item.textColor ?? defaults.textColor,
    backgroundColor: item.backgroundColor ?? defaults.backgroundColor,
    borderColor: item.borderColor ?? defaults.borderColor,
    borderWidth: item.borderWidth ?? defaults.borderWidth,
    borderStyle: item.borderStyle ?? defaults.borderStyle,
  };
}

function normalizeAssetItem(item: AssetItem): AssetItem {
  return {
    ...item,
    fit: item.fit ?? "contain",
  };
}

function normalizeStoredItem(item: EditorItem): EditorItem {
  if (item.kind === "shape") {
    return normalizeShapeItem(item);
  }

  if (item.kind === "text") {
    return normalizeTextItem(item);
  }

  return normalizeAssetItem(item);
}

function createShape(shapeType: ShapeType, x: number, y: number): ShapeItem {
  const shared = {
    id: createId(),
    x,
    y,
    rotation: 0,
    stroke: "#24303b",
    strokeWidth: 2,
  };

  switch (shapeType) {
    case "circle": {
      const fill = "#ffd56a";

      return {
        ...shared,
        kind: "shape",
        shapeType,
        width: 120,
        height: 120,
        fill,
      };
    }
    case "square": {
      const fill = "#7fd1b9";

      return {
        ...shared,
        kind: "shape",
        shapeType,
        width: 120,
        height: 120,
        fill,
      };
    }
    case "triangle": {
      const fill = "#f69a7b";

      return {
        ...shared,
        kind: "shape",
        shapeType,
        width: 150,
        height: 120,
        fill,
      };
    }
    case "oval": {
      const fill = "#8ac5ff";

      return {
        ...shared,
        kind: "shape",
        shapeType,
        width: 180,
        height: 110,
        fill,
      };
    }
    default: {
      const fill = "#f2efe7";

      return {
        ...shared,
        kind: "shape",
        shapeType,
        width: 180,
        height: 110,
        fill,
      };
    }
  }
}

function createTextBox(boxType: BoxType, x: number, y: number): TextItem {
  const appearance = getDefaultTextBoxAppearance(boxType);

  return {
    id: createId(),
    kind: "text",
    x,
    y,
    width: 210,
    height: 92,
    rotation: 0,
    boxType,
    content: boxType === "number" ? "12" : "Write a title",
    fontSize: boxType === "number" ? 32 : 26,
    align: "center",
    ...appearance,
  };
}

function getDefaultItems(): EditorItem[] {
  return [
    createTextBox("text", 64, 48),
    {
      ...createTextBox("number", 320, 180),
      width: 160,
      height: 110,
      content: "7",
    },
    createShape("triangle", 520, 360),
    createShape("circle", 120, 320),
  ];
}

function deserializeStoredLayout(source: unknown): StoredLayout {
  const fallbackItems = getDefaultItems();

  if (Array.isArray(source)) {
    return {
      items: source.map((item) => normalizeStoredItem(item as EditorItem)),
      groups: [],
    };
  }

  if (!source || typeof source !== "object") {
    return { items: fallbackItems, groups: [] };
  }

  const layout = source as Partial<StoredLayout>;

  if (!Array.isArray(layout.items)) {
    return { items: fallbackItems, groups: [] };
  }

  const items = layout.items.map((item) => normalizeStoredItem(item));
  const groups = sanitizeGroups(layout.groups ?? [], items);

  return { items, groups };
}

function mergeAssets(
  currentAssets: LibraryAsset[],
  nextAssets: LibraryAsset[],
) {
  const merged = new Map(currentAssets.map((asset) => [asset.id, asset]));

  for (const asset of nextAssets) {
    merged.set(asset.id, asset);
  }

  return Array.from(merged.values()).sort(
    (left, right) => right.createdAt - left.createdAt,
  );
}

function mergeWorksheetSummaries(
  currentWorksheets: CloudWorksheetSummary[],
  nextWorksheet: CloudWorksheetSummary,
) {
  const merged = new Map(
    currentWorksheets.map((worksheet) => [worksheet.id, worksheet]),
  );
  merged.set(nextWorksheet.id, nextWorksheet);

  return Array.from(merged.values()).sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
}

function rehydrateAssetItems(
  currentItems: EditorItem[],
  assets: LibraryAsset[],
) {
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  let changed = false;

  const nextItems = currentItems.map((item) => {
    if (item.kind !== "asset") {
      return item;
    }

    const primaryAsset = assetMap.get(item.assetId);
    const nextItem: AssetItem = {
      ...item,
      assetName: primaryAsset?.name ?? item.assetName,
      src: primaryAsset?.dataUrl ?? item.src,
    };

    if (nextItem.assetName !== item.assetName || nextItem.src !== item.src) {
      changed = true;
    }

    return nextItem;
  });

  return changed ? nextItems : currentItems;
}

function sanitizeGroups(groups: ItemGroup[], items: EditorItem[]) {
  const validIds = new Set(items.map((item) => item.id));
  const seenIds = new Set<string>();

  return groups
    .map((group) => ({
      itemIds: group.itemIds.filter((itemId) => validIds.has(itemId)),
      id: group.id,
    }))
    .filter((group) => {
      if (group.itemIds.length < 2) {
        return false;
      }

      for (const itemId of group.itemIds) {
        if (seenIds.has(itemId)) {
          return false;
        }
      }

      for (const itemId of group.itemIds) {
        seenIds.add(itemId);
      }

      return true;
    });
}

function parseStoredLayout(): StoredLayout {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return deserializeStoredLayout(null);
    }

    return deserializeStoredLayout(
      JSON.parse(raw) as EditorItem[] | StoredLayout,
    );
  } catch {
    return deserializeStoredLayout(null);
  }
}

async function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function formatPersistenceError(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "Something went wrong while talking to cloud storage";
}

function validateCloudUsername(username: string) {
  const normalizedUsername = username.trim();

  if (
    normalizedUsername.length < 3 ||
    normalizedUsername.length > 30 ||
    !USERNAME_PATTERN.test(normalizedUsername)
  ) {
    return USERNAME_REQUIREMENTS_MESSAGE;
  }

  return null;
}

async function readImageSize(dataUrl: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () =>
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("Failed to decode image"));
    image.src = dataUrl;
  });
}

function getTextItemStyle(item: TextItem) {
  return {
    fontSize: `${item.fontSize}px`,
    textAlign: item.align,
    color: item.textColor,
    backgroundColor: item.backgroundColor,
    borderColor: item.borderColor,
    borderWidth: `${item.borderWidth}px`,
    borderStyle: item.borderStyle,
  } as const;
}

function cloneItem(item: EditorItem, x?: number, y?: number): EditorItem {
  const nextX =
    typeof x === "number"
      ? clamp(x, 0, PAGE_WIDTH - item.width)
      : clamp(item.x + 22, 0, PAGE_WIDTH - item.width);
  const nextY =
    typeof y === "number"
      ? clamp(y, 0, PAGE_HEIGHT - item.height)
      : clamp(item.y + 22, 0, PAGE_HEIGHT - item.height);

  return {
    ...item,
    id: createId(),
    x: round(nextX),
    y: round(nextY),
  };
}

function removeIdsFromGroups(groups: ItemGroup[], itemIds: string[]) {
  const removedIds = new Set(itemIds);

  return groups
    .map((group) => ({
      ...group,
      itemIds: group.itemIds.filter((itemId) => !removedIds.has(itemId)),
    }))
    .filter((group) => group.itemIds.length >= 2);
}

function areSameIdSet(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  const rightIds = new Set(right);
  return left.every((itemId) => rightIds.has(itemId));
}

function expandSelectionWithGroups(
  itemIds: string[],
  items: EditorItem[],
  groups: ItemGroup[],
) {
  const expandedIds = new Set(itemIds);

  for (const group of groups) {
    if (group.itemIds.some((itemId) => expandedIds.has(itemId))) {
      for (const itemId of group.itemIds) {
        expandedIds.add(itemId);
      }
    }
  }

  return items
    .filter((item) => expandedIds.has(item.id))
    .map((item) => item.id);
}

function cloneItemsWithOffset(
  itemsToClone: EditorItem[],
  targetX?: number,
  targetY?: number,
) {
  const minX = Math.min(...itemsToClone.map((item) => item.x));
  const minY = Math.min(...itemsToClone.map((item) => item.y));
  const deltaX = typeof targetX === "number" ? targetX - minX : 22;
  const deltaY = typeof targetY === "number" ? targetY - minY : 22;

  return itemsToClone.map((item) =>
    cloneItem(item, item.x + deltaX, item.y + deltaY),
  );
}

function moveItemsInLayer(
  currentItems: EditorItem[],
  itemIds: string[],
  direction: LayerMoveDirection,
) {
  const selectedIds = new Set(itemIds);

  if (selectedIds.size === 0) {
    return currentItems;
  }

  if (direction === "front") {
    const remaining = currentItems.filter((item) => !selectedIds.has(item.id));
    const selection = currentItems.filter((item) => selectedIds.has(item.id));
    return [...remaining, ...selection];
  }

  if (direction === "back") {
    const selection = currentItems.filter((item) => selectedIds.has(item.id));
    const remaining = currentItems.filter((item) => !selectedIds.has(item.id));
    return [...selection, ...remaining];
  }

  const nextItems = [...currentItems];

  if (direction === "forward") {
    for (let index = nextItems.length - 2; index >= 0; index -= 1) {
      if (
        selectedIds.has(nextItems[index].id) &&
        !selectedIds.has(nextItems[index + 1].id)
      ) {
        [nextItems[index], nextItems[index + 1]] = [
          nextItems[index + 1],
          nextItems[index],
        ];
      }
    }

    return nextItems;
  }

  for (let index = 1; index < nextItems.length; index += 1) {
    if (
      selectedIds.has(nextItems[index].id) &&
      !selectedIds.has(nextItems[index - 1].id)
    ) {
      [nextItems[index - 1], nextItems[index]] = [
        nextItems[index],
        nextItems[index - 1],
      ];
    }
  }

  return nextItems;
}

function canMoveItemsInLayer(
  currentItems: EditorItem[],
  itemIds: string[],
  direction: LayerMoveDirection,
) {
  const selectedIds = new Set(itemIds);

  if (selectedIds.size === 0) {
    return false;
  }

  if (direction === "front") {
    return currentItems.some(
      (item, index) =>
        selectedIds.has(item.id) &&
        index < currentItems.length - selectedIds.size,
    );
  }

  if (direction === "back") {
    return currentItems.some(
      (item, index) => selectedIds.has(item.id) && index >= selectedIds.size,
    );
  }

  if (direction === "forward") {
    return currentItems.some(
      (item, index) =>
        selectedIds.has(item.id) &&
        index < currentItems.length - 1 &&
        !selectedIds.has(currentItems[index + 1].id),
    );
  }

  return currentItems.some(
    (item, index) =>
      selectedIds.has(item.id) &&
      index > 0 &&
      !selectedIds.has(currentItems[index - 1].id),
  );
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

function App() {
  const cloudPersistence = getCloudPersistenceConfig();
  const cloudConfigured = isCloudPersistenceEnabled();
  const initialLayoutRef = useRef<StoredLayout | null>(null);
  const initialCloudSessionRef = useRef(getStoredCloudAccountSession());

  if (!initialLayoutRef.current) {
    initialLayoutRef.current = parseStoredLayout();
  }

  const initialCloudSession = initialCloudSessionRef.current;

  const [items, setItems] = useState<EditorItem[]>(
    () => initialLayoutRef.current!.items,
  );
  const [groups, setGroups] = useState<ItemGroup[]>(
    () => initialLayoutRef.current!.groups,
  );
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [worksheetName, setWorksheetName] = useState("Untitled worksheet");
  const [savedWorksheets, setSavedWorksheets] = useState<
    CloudWorksheetSummary[]
  >([]);
  const [cloudAccount, setCloudAccount] = useState<CloudAccount | null>(() =>
    initialCloudSession
      ? {
          accountId: initialCloudSession.accountId,
          username: initialCloudSession.username,
        }
      : null,
  );
  const [activeWorksheetId, setActiveWorksheetId] = useState<string | null>(
    null,
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [clipboardItem, setClipboardItem] = useState<ClipboardState | null>(
    null,
  );
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionMarquee | null>(
    null,
  );
  const [status, setStatus] = useState("Ready");
  const [assetBusy, setAssetBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [cloudAuthChecked, setCloudAuthChecked] = useState(
    !cloudConfigured || !initialCloudSession,
  );
  const [cloudAuthMode, setCloudAuthMode] = useState<"login" | "signup">(
    "login",
  );
  const [cloudUsername, setCloudUsername] = useState("");
  const [cloudPassword, setCloudPassword] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [assetSearch, setAssetSearch] = useState("");
  const pageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const selectionRef = useRef<SelectionMarquee | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef(items);
  const groupsRef = useRef(groups);
  const cloudReady = cloudConfigured && Boolean(cloudAccount);

  const itemGroupMap = useMemo(() => {
    const nextMap = new Map<string, ItemGroup>();

    for (const group of groups) {
      for (const itemId of group.itemIds) {
        nextMap.set(itemId, group);
      }
    }

    return nextMap;
  }, [groups]);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIdSet.has(item.id)),
    [items, selectedIdSet],
  );

  const selectedItem = useMemo(
    () => (selectedItems.length === 1 ? selectedItems[0] : null),
    [selectedItems],
  );

  const selectedGroup = useMemo(
    () =>
      groups.find((group) => areSameIdSet(group.itemIds, selectedIds)) ?? null,
    [groups, selectedIds],
  );

  const selectedGroupBounds = useMemo(() => {
    if (!selectedGroup) {
      return null;
    }

    const groupItems = items.filter((item) =>
      selectedGroup.itemIds.includes(item.id),
    );

    if (groupItems.length < 2) {
      return null;
    }

    const left = Math.min(...groupItems.map((item) => item.x));
    const top = Math.min(...groupItems.map((item) => item.y));
    const right = Math.max(...groupItems.map((item) => item.x + item.width));
    const bottom = Math.max(...groupItems.map((item) => item.y + item.height));

    return {
      left,
      top,
      width: right - left,
      height: bottom - top,
    };
  }, [items, selectedGroup]);

  const contextMenuItem = useMemo(
    () => items.find((item) => item.id === contextMenu?.itemId) ?? null,
    [contextMenu?.itemId, items],
  );

  const contextMenuGroup = useMemo(
    () => groups.find((group) => group.id === contextMenu?.groupId) ?? null,
    [contextMenu?.groupId, groups],
  );

  const contextTargetIds = contextMenu?.targetIds ?? [];

  const filteredAssets = useMemo(() => {
    const query = assetSearch.trim().toLowerCase();

    if (!query) {
      return assets;
    }

    return assets.filter((asset) => asset.name.toLowerCase().includes(query));
  }, [assetSearch, assets]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ items, groups }));
  }, [groups, items]);

  useEffect(() => {
    itemsRef.current = items;
    groupsRef.current = groups;
  }, [groups, items]);

  useEffect(() => {
    if (!cloudReady || assets.length === 0) {
      return;
    }

    setItems((currentItems) => rehydrateAssetItems(currentItems, assets));
  }, [assets, cloudReady]);

  useEffect(() => {
    const validItemIds = new Set(items.map((item) => item.id));

    setSelectedIds((currentIds) => {
      const nextIds = currentIds.filter((itemId) => validItemIds.has(itemId));
      return nextIds.length === currentIds.length ? currentIds : nextIds;
    });

    if (editingId && !validItemIds.has(editingId)) {
      setEditingId(null);
    }

    setGroups((currentGroups) => {
      const nextGroups = sanitizeGroups(currentGroups, items);

      if (
        nextGroups.length === currentGroups.length &&
        nextGroups.every((group, index) =>
          areSameIdSet(group.itemIds, currentGroups[index].itemIds),
        )
      ) {
        return currentGroups;
      }

      return nextGroups;
    });
  }, [editingId, items]);

  useEffect(() => {
    if (
      editingId &&
      (selectedIds.length !== 1 || selectedIds[0] !== editingId)
    ) {
      setEditingId(null);
    }
  }, [editingId, selectedIds]);

  useEffect(() => {
    if (!cloudConfigured) {
      setCloudAuthChecked(true);
      return;
    }

    const storedSession = getStoredCloudAccountSession();

    if (!storedSession) {
      setCloudAuthChecked(true);
      return;
    }

    let cancelled = false;
    setCloudAuthChecked(false);

    async function validateCloudSession() {
      try {
        const account = await getCurrentCloudAccount();

        if (cancelled) {
          return;
        }

        if (!account) {
          clearStoredCloudAccountSession();
          setCloudAccount(null);
          setStatus("Cloud session expired. Sign in again.");
          return;
        }

        setCloudAccount(account);
      } catch {
        if (!cancelled) {
          clearStoredCloudAccountSession();
          setCloudAccount(null);
          setStatus("Failed to restore cloud session");
        }
      } finally {
        if (!cancelled) {
          setCloudAuthChecked(true);
        }
      }
    }

    void validateCloudSession();

    return () => {
      cancelled = true;
    };
  }, [cloudConfigured]);

  useEffect(() => {
    let cancelled = false;

    async function loadPersistenceState() {
      try {
        if (cloudConfigured) {
          if (!cloudAuthChecked) {
            return;
          }

          if (!cloudAccount) {
            if (!cancelled) {
              setAssets([]);
              setSavedWorksheets([]);
              setActiveWorksheetId(null);
              setStatus("Sign in to access account worksheets and assets");
            }

            return;
          }

          const [loadedAssets, worksheets] = await Promise.all([
            listCloudAssets(),
            listCloudWorksheets(),
          ]);

          if (!cancelled) {
            setAssets(loadedAssets);
            setSavedWorksheets(worksheets);
            setStatus("Cloud library ready");
          }

          return;
        }

        const loadedAssets = await loadAssets();

        if (!cancelled) {
          setAssets(loadedAssets);
        }
      } catch {
        if (!cancelled) {
          setStatus(
            cloudReady
              ? "Failed to load cloud worksheets or assets"
              : "Failed to load saved assets",
          );
        }
      }
    }

    void loadPersistenceState();

    return () => {
      cancelled = true;
    };
  }, [cloudAccount, cloudAuthChecked, cloudConfigured, cloudReady]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;

      if (drag) {
        event.preventDefault();

        const deltaX = event.clientX - drag.startX;
        const deltaY = event.clientY - drag.startY;

        setItems((currentItems) => {
          if (drag.mode === "move") {
            const originEntries = drag.itemIds
              .map((itemId) => drag.origins[itemId])
              .filter(Boolean);

            const minOriginX = Math.min(
              ...originEntries.map((origin) => origin.x),
            );
            const minOriginY = Math.min(
              ...originEntries.map((origin) => origin.y),
            );
            const maxOriginRight = Math.max(
              ...originEntries.map((origin) => origin.x + origin.width),
            );
            const maxOriginBottom = Math.max(
              ...originEntries.map((origin) => origin.y + origin.height),
            );
            const boundedDeltaX = clamp(
              deltaX,
              -minOriginX,
              PAGE_WIDTH - maxOriginRight,
            );
            const boundedDeltaY = clamp(
              deltaY,
              -minOriginY,
              PAGE_HEIGHT - maxOriginBottom,
            );

            return currentItems.map((item) => {
              const origin = drag.origins[item.id];

              if (!origin) {
                return item;
              }

              return {
                ...item,
                x: round(origin.x + boundedDeltaX),
                y: round(origin.y + boundedDeltaY),
              };
            });
          }

          return currentItems.map((item) => {
            const origin = drag.origins[item.id];

            if (!origin) {
              return item;
            }

            const minSize = getMinSize(item);
            let nextX = origin.x;
            let nextY = origin.y;
            let nextWidth = origin.width;
            let nextHeight = origin.height;

            if (drag.handle === "nw") {
              nextX = clamp(
                origin.x + deltaX,
                0,
                origin.x + origin.width - minSize.width,
              );
              nextY = clamp(
                origin.y + deltaY,
                0,
                origin.y + origin.height - minSize.height,
              );
              nextWidth = origin.x + origin.width - nextX;
              nextHeight = origin.y + origin.height - nextY;
            }

            if (drag.handle === "ne") {
              nextY = clamp(
                origin.y + deltaY,
                0,
                origin.y + origin.height - minSize.height,
              );
              nextWidth = clamp(
                origin.width + deltaX,
                minSize.width,
                PAGE_WIDTH - origin.x,
              );
              nextHeight = origin.y + origin.height - nextY;
            }

            if (drag.handle === "sw") {
              nextX = clamp(
                origin.x + deltaX,
                0,
                origin.x + origin.width - minSize.width,
              );
              nextWidth = origin.x + origin.width - nextX;
              nextHeight = clamp(
                origin.height + deltaY,
                minSize.height,
                PAGE_HEIGHT - origin.y,
              );
            }

            if (drag.handle === "se") {
              nextWidth = clamp(
                origin.width + deltaX,
                minSize.width,
                PAGE_WIDTH - origin.x,
              );
              nextHeight = clamp(
                origin.height + deltaY,
                minSize.height,
                PAGE_HEIGHT - origin.y,
              );
            }

            if (
              item.kind === "shape" &&
              (item.shapeType === "circle" || item.shapeType === "square")
            ) {
              const nextSize = Math.max(nextWidth, nextHeight);

              if (drag.handle === "nw") {
                nextX = clamp(
                  origin.x + origin.width - nextSize,
                  0,
                  PAGE_WIDTH - nextSize,
                );
                nextY = clamp(
                  origin.y + origin.height - nextSize,
                  0,
                  PAGE_HEIGHT - nextSize,
                );
              }

              if (drag.handle === "ne") {
                nextY = clamp(
                  origin.y + origin.height - nextSize,
                  0,
                  PAGE_HEIGHT - nextSize,
                );
              }

              if (drag.handle === "sw") {
                nextX = clamp(
                  origin.x + origin.width - nextSize,
                  0,
                  PAGE_WIDTH - nextSize,
                );
              }

              nextWidth = nextSize;
              nextHeight = nextSize;
            }

            return {
              ...item,
              x: round(nextX),
              y: round(nextY),
              width: round(nextWidth),
              height: round(nextHeight),
            };
          });
        });

        return;
      }

      const marquee = selectionRef.current;

      if (!marquee) {
        return;
      }

      event.preventDefault();
      const nextMarquee = {
        ...marquee,
        currentX: event.clientX,
        currentY: event.clientY,
      };
      selectionRef.current = nextMarquee;
      setSelectionBox(nextMarquee);
    };

    const onPointerUp = () => {
      const marquee = selectionRef.current;

      dragRef.current = null;

      if (!marquee) {
        return;
      }

      selectionRef.current = null;
      setSelectionBox(null);

      const pageBounds = pageRef.current?.getBoundingClientRect();

      if (!pageBounds) {
        return;
      }

      const currentItems = itemsRef.current;
      const currentGroups = groupsRef.current;

      const left = Math.min(marquee.startX, marquee.currentX) - pageBounds.left;
      const top = Math.min(marquee.startY, marquee.currentY) - pageBounds.top;
      const right =
        Math.max(marquee.startX, marquee.currentX) - pageBounds.left;
      const bottom =
        Math.max(marquee.startY, marquee.currentY) - pageBounds.top;

      if (Math.abs(right - left) < 4 && Math.abs(bottom - top) < 4) {
        setSelectedIds(marquee.baseSelectionIds);
        return;
      }

      const hitIds = currentItems
        .filter((item) => {
          const itemRight = item.x + item.width;
          const itemBottom = item.y + item.height;

          return !(
            itemRight < left ||
            item.x > right ||
            itemBottom < top ||
            item.y > bottom
          );
        })
        .map((item) => item.id);

      setSelectedIds(
        expandSelectionWithGroups(
          [...marquee.baseSelectionIds, ...hitIds],
          currentItems,
          currentGroups,
        ),
      );
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (
        contextMenuRef.current &&
        event.target instanceof Node &&
        contextMenuRef.current.contains(event.target)
      ) {
        return;
      }

      setContextMenu(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (
      contextMenu &&
      ((contextMenu.scope === "item" && !contextMenuItem) ||
        (contextMenu.scope === "group" && !contextMenuGroup) ||
        (contextMenu.scope !== "stage" && contextTargetIds.length === 0))
    ) {
      setContextMenu(null);
    }
  }, [contextMenu, contextMenuGroup, contextMenuItem, contextTargetIds.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const hasModifierKey = event.ctrlKey || event.metaKey;

      if (event.key === "Escape") {
        return;
      }

      if (hasModifierKey && !event.altKey && !isEditableTarget(target)) {
        const normalizedKey = event.key.toLowerCase();

        if (normalizedKey === "c" && selectedIds.length > 0) {
          event.preventDefault();
          copyItemsByIds(selectedIds, selectedGroup?.id ?? null);
          return;
        }

        if (normalizedKey === "x" && selectedIds.length > 0) {
          event.preventDefault();
          cutItemsByIds(selectedIds, selectedGroup?.id ?? null);
          return;
        }

        if (normalizedKey === "v" && clipboardItem) {
          event.preventDefault();
          pasteClipboardItem();
          return;
        }
      }

      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedIds.length > 0
      ) {
        if (isEditableTarget(target)) {
          return;
        }

        const removedIds = new Set(selectedIds);
        setItems((currentItems) =>
          currentItems.filter((item) => !removedIds.has(item.id)),
        );
        setGroups((currentGroups) =>
          removeIdsFromGroups(currentGroups, selectedIds),
        );
        setSelectedIds([]);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clipboardItem, selectedGroup, selectedIds]);

  function addItem(item: EditorItem) {
    setItems((currentItems) => [...currentItems, item]);
    setSelectedIds([item.id]);
  }

  function ungroupById(groupId: string) {
    setGroups((currentGroups) =>
      currentGroups.filter((group) => group.id !== groupId),
    );
    setStatus("Group ungrouped");
  }

  function getSelectableIds(itemId: string) {
    return itemGroupMap.get(itemId)?.itemIds ?? [itemId];
  }

  function getDragItemIds(itemId: string) {
    if (selectedIds.length > 1 && selectedIdSet.has(itemId)) {
      return selectedIds;
    }

    return getSelectableIds(itemId);
  }

  function beginSelectionMarquee(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.target !== pageRef.current) {
      return;
    }

    setContextMenu(null);
    setEditingId(null);

    const baseSelectionIds =
      event.shiftKey || event.ctrlKey || event.metaKey ? selectedIds : [];
    const nextMarquee = {
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      baseSelectionIds,
    };

    selectionRef.current = nextMarquee;
    setSelectionBox(nextMarquee);
    setSelectedIds(baseSelectionIds);
  }

  function openContextMenu(
    event: React.MouseEvent,
    scope: ContextMenuState["scope"],
    itemId: string | null,
  ) {
    setEditingId(null);
    event.preventDefault();
    event.stopPropagation();

    let nextScope = scope;
    let targetIds: string[] = [];
    let groupId: string | null = null;

    if (itemId) {
      const itemGroup = itemGroupMap.get(itemId) ?? null;

      if (itemGroup) {
        nextScope = "group";
        targetIds = itemGroup.itemIds;
        groupId = itemGroup.id;
        setSelectedIds(itemGroup.itemIds);
      } else if (selectedIds.length > 1 && selectedIds.includes(itemId)) {
        nextScope = "selection";
        targetIds = selectedIds;
      } else {
        nextScope = "item";
        targetIds = [itemId];
        setSelectedIds([itemId]);
      }
    }

    const pageBounds = pageRef.current?.getBoundingClientRect();
    const withinPage =
      pageBounds &&
      event.clientX >= pageBounds.left &&
      event.clientX <= pageBounds.right &&
      event.clientY >= pageBounds.top &&
      event.clientY <= pageBounds.bottom;
    const canvasX = withinPage ? round(event.clientX - pageBounds.left) : null;
    const canvasY = withinPage ? round(event.clientY - pageBounds.top) : null;

    setContextMenu({
      x: clamp(event.clientX, 12, window.innerWidth - CONTEXT_MENU_WIDTH),
      y: clamp(event.clientY, 12, window.innerHeight - CONTEXT_MENU_HEIGHT),
      scope: nextScope,
      itemId,
      targetIds,
      groupId,
      canvasX,
      canvasY,
    });
  }

  function startMove(event: React.PointerEvent, item: EditorItem) {
    if (event.button !== 0) {
      return;
    }

    if (editingId === item.id) {
      return;
    }

    event.stopPropagation();
    setContextMenu(null);

    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      const selectableIds = getSelectableIds(item.id);
      const selectableIdSet = new Set(selectableIds);
      const allSelected = selectableIds.every((itemId) =>
        selectedIdSet.has(itemId),
      );
      const nextSelectedIds = allSelected
        ? selectedIds.filter((itemId) => !selectableIdSet.has(itemId))
        : [...selectedIds, ...selectableIds];

      setSelectedIds(expandSelectionWithGroups(nextSelectedIds, items, groups));
      return;
    }

    const dragItemIds = getDragItemIds(item.id);

    setSelectedIds(dragItemIds);

    if (dragItemIds.length > 1 && !areSameIdSet(selectedIds, dragItemIds)) {
      setStatus("Group selected");
    }

    dragRef.current = {
      itemIds: dragItemIds,
      mode: "move",
      startX: event.clientX,
      startY: event.clientY,
      origins: Object.fromEntries(
        items
          .filter((entry) => dragItemIds.includes(entry.id))
          .map((entry) => [
            entry.id,
            {
              x: entry.x,
              y: entry.y,
              width: entry.width,
              height: entry.height,
            },
          ]),
      ),
    };
  }

  function startResize(
    event: React.PointerEvent,
    item: EditorItem,
    handle: ResizeHandle,
  ) {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    setContextMenu(null);
    setSelectedIds([item.id]);
    dragRef.current = {
      itemIds: [item.id],
      mode: "resize",
      handle,
      startX: event.clientX,
      startY: event.clientY,
      origins: {
        [item.id]: {
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
        },
      },
    };
  }

  function updateSelectedItem(updater: (item: EditorItem) => EditorItem) {
    if (!selectedItem) {
      return;
    }

    setItems((currentItems) =>
      currentItems.map((item) =>
        item.id === selectedItem.id ? updater(item) : item,
      ),
    );
  }

  function updateTextItemValue(itemId: string, value: string) {
    setItems((currentItems) =>
      currentItems.map((item) => {
        if (item.id !== itemId || item.kind !== "text") {
          return item;
        }

        return {
          ...item,
          content: value,
        };
      }),
    );
  }

  function startInlineEditing(itemId: string) {
    setSelectedIds([itemId]);
    setEditingId(itemId);
  }

  function stopInlineEditing() {
    setEditingId(null);
  }

  async function handleAssetUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);

    if (files.length === 0) {
      return;
    }

    if (cloudConfigured && !cloudReady) {
      setStatus("Sign in to upload account assets");
      event.target.value = "";
      return;
    }

    setAssetBusy(true);
    setStatus(
      cloudReady
        ? `Uploading ${files.length} asset${files.length > 1 ? "s" : ""} to your account`
        : `Saving ${files.length} asset${files.length > 1 ? "s" : ""} locally`,
    );

    try {
      const nextAssets: LibraryAsset[] = [];

      for (const file of files) {
        if (cloudReady) {
          nextAssets.push(await uploadCloudAsset(file));
          continue;
        }

        const dataUrl = await readFileAsDataUrl(file);
        const imageSize = await readImageSize(dataUrl);
        const asset: StoredAsset = {
          id: createId(),
          name: file.name,
          dataUrl,
          width: imageSize.width,
          height: imageSize.height,
          createdAt: Date.now(),
        };

        await saveAsset(asset);
        nextAssets.push(asset);
      }

      setAssets((currentAssets) => mergeAssets(currentAssets, nextAssets));
      setStatus(
        cloudReady
          ? `${files.length} asset${files.length > 1 ? "s" : ""} uploaded to cloud storage`
          : `${files.length} asset${files.length > 1 ? "s" : ""} stored on this device`,
      );
    } catch (error) {
      setStatus(formatPersistenceError(error));
    } finally {
      setAssetBusy(false);
      event.target.value = "";
    }
  }

  function addAssetToPage(asset: LibraryAsset) {
    const width = Math.min(240, Math.max(120, asset.width / 2));
    const aspectRatio = asset.height / asset.width || 1;
    const height = clamp(width * aspectRatio, 90, 280);

    addItem({
      id: createId(),
      kind: "asset",
      assetId: asset.id,
      assetName: asset.name,
      src: asset.dataUrl,
      x: 90,
      y: 120,
      width: round(width),
      height: round(height),
      rotation: 0,
      fit: "contain",
    });
  }

  async function deleteAssetFromLibrary(assetId: string) {
    if (cloudConfigured && !cloudReady) {
      setStatus("Sign in to manage account assets");
      return;
    }

    if (cloudReady) {
      await deleteCloudAsset(assetId);
    } else {
      await removeAsset(assetId);
    }

    setAssets((currentAssets) =>
      currentAssets.filter((asset) => asset.id !== assetId),
    );
    setStatus(
      cloudReady
        ? "Asset removed from cloud library"
        : "Asset removed from local library",
    );
  }

  async function refreshCloudLibrary(showStatus = false) {
    if (!cloudReady) {
      if (cloudConfigured) {
        setStatus("Sign in to refresh your account library");
      }

      return;
    }

    setCloudBusy(true);

    try {
      const [loadedAssets, worksheets] = await Promise.all([
        listCloudAssets(),
        listCloudWorksheets(),
      ]);

      setAssets(loadedAssets);
      setSavedWorksheets(worksheets);

      if (showStatus) {
        setStatus("Cloud library refreshed");
      }
    } catch (error) {
      setStatus(formatPersistenceError(error));
    } finally {
      setCloudBusy(false);
    }
  }

  async function saveWorksheetToCloud(saveAsCopy = false) {
    if (!cloudReady) {
      setStatus("Configure Supabase to enable durable worksheet saves");
      if (cloudConfigured) {
        setStatus("Sign in to save worksheets to your account");
      }

      return;
    }

    const nextName = worksheetName.trim() || "Untitled worksheet";

    setCloudBusy(true);
    setStatus(
      activeWorksheetId && !saveAsCopy
        ? "Updating worksheet in cloud"
        : "Saving worksheet to cloud",
    );

    try {
      const savedWorksheet = await saveCloudWorksheet({
        id: saveAsCopy ? undefined : (activeWorksheetId ?? undefined),
        name: nextName,
        items,
        groups,
      });

      const summary: CloudWorksheetSummary = {
        id: savedWorksheet.id,
        name: savedWorksheet.name,
        itemCount: savedWorksheet.itemCount,
        createdAt: savedWorksheet.createdAt,
        updatedAt: savedWorksheet.updatedAt,
      };

      setWorksheetName(savedWorksheet.name);
      setActiveWorksheetId(savedWorksheet.id);
      setSavedWorksheets((currentWorksheets) =>
        mergeWorksheetSummaries(currentWorksheets, summary),
      );
      setStatus("Worksheet saved to cloud");
    } catch (error) {
      setStatus(formatPersistenceError(error));
    } finally {
      setCloudBusy(false);
    }
  }

  async function loadWorksheetFromCloud(worksheetId: string) {
    if (!cloudReady) {
      return;
    }

    setCloudBusy(true);
    setStatus("Loading worksheet from cloud");

    try {
      const worksheet = await loadCloudWorksheet(worksheetId);
      const layout = deserializeStoredLayout(worksheet.layout);
      const hydratedItems = rehydrateAssetItems(layout.items, assets);

      setItems(hydratedItems);
      setGroups(layout.groups);
      setSelectedIds(hydratedItems[0] ? [hydratedItems[0].id] : []);
      setEditingId(null);
      setWorksheetName(worksheet.name);
      setActiveWorksheetId(worksheet.id);
      setStatus("Worksheet loaded from cloud");
    } catch (error) {
      setStatus(formatPersistenceError(error));
    } finally {
      setCloudBusy(false);
    }
  }

  async function removeWorksheetFromCloud(worksheetId: string) {
    if (!cloudReady) {
      return;
    }

    setCloudBusy(true);

    try {
      await deleteCloudWorksheet(worksheetId);
      setSavedWorksheets((currentWorksheets) =>
        currentWorksheets.filter((worksheet) => worksheet.id !== worksheetId),
      );

      if (activeWorksheetId === worksheetId) {
        setActiveWorksheetId(null);
      }

      setStatus("Worksheet removed from cloud");
    } catch (error) {
      setStatus(formatPersistenceError(error));
    } finally {
      setCloudBusy(false);
    }
  }

  async function handleCloudAuthSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    if (!cloudConfigured) {
      setStatus("Configure Supabase before creating accounts");
      return;
    }

    if (cloudAuthMode === "signup") {
      const usernameValidationError = validateCloudUsername(cloudUsername);

      if (usernameValidationError) {
        setStatus(usernameValidationError);
        return;
      }
    }

    setAuthBusy(true);
    setStatus(
      cloudAuthMode === "signup"
        ? "Creating your cloud account"
        : "Signing in to your cloud account",
    );

    try {
      const session =
        cloudAuthMode === "signup"
          ? await signUpCloudAccount(cloudUsername, cloudPassword)
          : await signInCloudAccount(cloudUsername, cloudPassword);

      setCloudAccount({
        accountId: session.accountId,
        username: session.username,
      });
      setCloudAuthChecked(true);
      setCloudPassword("");
      setAssets([]);
      setSavedWorksheets([]);
      setActiveWorksheetId(null);
      setStatus(`Signed in as ${session.username}`);
    } catch (error) {
      setStatus(formatPersistenceError(error));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleCloudSignOut() {
    setAuthBusy(true);

    try {
      await signOutCloudAccount();
    } catch (error) {
      setStatus(formatPersistenceError(error));
    } finally {
      setCloudAccount(null);
      setAssets([]);
      setSavedWorksheets([]);
      setActiveWorksheetId(null);
      setCloudPassword("");
      setAuthBusy(false);
      setStatus("Signed out of cloud account");
    }
  }

  function deleteItemsByIds(itemIds: string[]) {
    if (itemIds.length === 0) {
      return;
    }

    const removedIds = new Set(itemIds);
    setItems((currentItems) =>
      currentItems.filter((entry) => !removedIds.has(entry.id)),
    );
    setGroups((currentGroups) => removeIdsFromGroups(currentGroups, itemIds));
    setSelectedIds((currentIds) =>
      currentIds.filter((itemId) => !removedIds.has(itemId)),
    );

    if (editingId && removedIds.has(editingId)) {
      setEditingId(null);
    }
  }

  function copyItemsByIds(itemIds: string[], groupId: string | null = null) {
    const copiedItems = items.filter((entry) => itemIds.includes(entry.id));

    if (copiedItems.length === 0) {
      return;
    }

    setClipboardItem({
      items: copiedItems,
      mode: "copy",
      group: groupId
        ? (groups.find((group) => group.id === groupId) ?? null)
        : null,
    });
    setStatus(copiedItems.length > 1 ? "Selection copied" : "Element copied");
  }

  function cutItemsByIds(itemIds: string[], groupId: string | null = null) {
    const cutItems = items.filter((entry) => itemIds.includes(entry.id));

    if (cutItems.length === 0) {
      return;
    }

    setClipboardItem({
      items: cutItems,
      mode: "cut",
      group: groupId
        ? (groups.find((group) => group.id === groupId) ?? null)
        : null,
    });
    deleteItemsByIds(itemIds);
    setStatus(cutItems.length > 1 ? "Selection cut" : "Element cut");
  }

  function moveSelection(direction: LayerMoveDirection, itemIds = selectedIds) {
    if (itemIds.length === 0) {
      return;
    }

    setItems((currentItems) =>
      moveItemsInLayer(currentItems, itemIds, direction),
    );
  }

  function pasteClipboardItem() {
    if (!clipboardItem) {
      return;
    }

    const duplicates = cloneItemsWithOffset(
      clipboardItem.items,
      contextMenu?.canvasX ?? undefined,
      contextMenu?.canvasY ?? undefined,
    );

    setItems((currentItems) => [...currentItems, ...duplicates]);
    setSelectedIds(duplicates.map((item) => item.id));

    const clipboardGroup = clipboardItem.group;

    if (clipboardGroup) {
      setGroups((currentGroups) => [
        ...currentGroups,
        {
          id: createId(),
          itemIds: duplicates.map((item) => item.id),
        },
      ]);
    }

    setStatus(
      clipboardItem.mode === "cut"
        ? duplicates.length > 1
          ? "Selection pasted"
          : "Element pasted"
        : duplicates.length > 1
          ? "Copied selection pasted"
          : "Copied element pasted",
    );
  }

  function runContextMenuAction(action: () => void) {
    action();
    setContextMenu(null);
  }

  async function exportPdf() {
    if (!pageRef.current) {
      return;
    }

    setExportBusy(true);
    setStatus("Rendering PDF export");

    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);
      const canvas = await html2canvas(pageRef.current, {
        backgroundColor: "#ffffff",
        scale: 2,
        useCORS: true,
      });

      const imageData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "px",
        format: [PAGE_WIDTH, PAGE_HEIGHT],
      });

      pdf.addImage(imageData, "PNG", 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
      pdf.save("worksheet.pdf");
      setStatus("PDF exported");
    } catch {
      setStatus("PDF export failed");
    } finally {
      setExportBusy(false);
    }
  }

  function printWorksheet() {
    window.print();
  }

  const selectionLabel = selectedGroup
    ? `Group · ${selectedIds.length} items`
    : selectedItem
      ? selectedItem.kind
      : selectedIds.length > 1
        ? `${selectedIds.length} items selected`
        : "No selection";

  const accountPanelStatus = !cloudConfigured
    ? "Supabase optional"
    : !cloudAuthChecked
      ? "Checking session"
      : cloudAccount
        ? `@${cloudAccount.username}`
        : "Sign in required";

  const assetPanelStatus = !cloudConfigured
    ? "Local only"
    : cloudAccount
      ? "Account library"
      : "Sign in required";

  const assetEmptyMessage = !cloudConfigured
    ? "No local images yet."
    : cloudAccount
      ? "No account images yet."
      : "Sign in to access account images.";

  const worksheetPanelStatus = !cloudConfigured
    ? "Needs Supabase"
    : cloudAccount
      ? `${savedWorksheets.length} saved`
      : "Sign in required";

  const selectionBoxStyle = (() => {
    if (!selectionBox || !pageRef.current) {
      return null;
    }

    const pageBounds = pageRef.current.getBoundingClientRect();
    const left =
      Math.min(selectionBox.startX, selectionBox.currentX) - pageBounds.left;
    const top =
      Math.min(selectionBox.startY, selectionBox.currentY) - pageBounds.top;
    const width = Math.abs(selectionBox.currentX - selectionBox.startX);
    const height = Math.abs(selectionBox.currentY - selectionBox.startY);

    return {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    };
  })();

  return (
    <div className="app-shell">
      <p className="sr-only" aria-live="polite">
        {status}
      </p>

      <header className="app-header no-print">
        <div>
          <p className="eyebrow">Worksheet Generator</p>
          <h1>Worksheet</h1>
        </div>
        <div className="header-actions">
          <button type="button" className="secondary" onClick={printWorksheet}>
            Print
          </button>
          <button type="button" onClick={exportPdf} disabled={exportBusy}>
            {exportBusy ? "Exporting..." : "Export PDF"}
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar no-print">
          <section className="panel">
            <div className="panel-heading">
              <h2>Account</h2>
              <span>{accountPanelStatus}</span>
            </div>

            {!cloudConfigured ? (
              <div className="field-stack">
                <p className="plain-list">
                  Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env`
                  to enable account-backed worksheet saves.
                </p>
                <p className="plain-list">
                  Usernames are password-based only. There is no email signup or
                  email verification step.
                </p>
              </div>
            ) : cloudAccount ? (
              <div className="field-stack">
                <div className="account-chip">@{cloudAccount.username}</div>
                <p className="plain-list">
                  Assets and worksheets are private to this account.
                </p>
                <div className="panel-footer-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void handleCloudSignOut()}
                    disabled={authBusy || cloudBusy}
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            ) : (
              <form className="field-stack" onSubmit={handleCloudAuthSubmit}>
                <div className="auth-toggle-row">
                  <button
                    type="button"
                    className={
                      cloudAuthMode === "login" ? "secondary" : "ghost"
                    }
                    onClick={() => setCloudAuthMode("login")}
                    disabled={authBusy}
                  >
                    Log In
                  </button>
                  <button
                    type="button"
                    className={
                      cloudAuthMode === "signup" ? "secondary" : "ghost"
                    }
                    onClick={() => setCloudAuthMode("signup")}
                    disabled={authBusy}
                  >
                    Sign Up
                  </button>
                </div>
                <label>
                  Username
                  <input
                    type="text"
                    value={cloudUsername}
                    onChange={(event) => setCloudUsername(event.target.value)}
                    placeholder="teacher-anna"
                    autoComplete="username"
                    minLength={3}
                    maxLength={30}
                    title={USERNAME_REQUIREMENTS_MESSAGE}
                    disabled={authBusy || !cloudAuthChecked}
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    value={cloudPassword}
                    onChange={(event) => setCloudPassword(event.target.value)}
                    placeholder="At least 8 characters"
                    autoComplete={
                      cloudAuthMode === "signup"
                        ? "new-password"
                        : "current-password"
                    }
                    disabled={authBusy || !cloudAuthChecked}
                  />
                </label>
                <button type="submit" disabled={authBusy || !cloudAuthChecked}>
                  {authBusy
                    ? cloudAuthMode === "signup"
                      ? "Creating Account..."
                      : "Signing In..."
                    : cloudAuthMode === "signup"
                      ? "Create Account"
                      : "Log In"}
                </button>
                <p className="plain-list">{USERNAME_REQUIREMENTS_MESSAGE}</p>
                <p className="plain-list">
                  Usernames are case-insensitive and stay private to this app.
                </p>
              </form>
            )}
          </section>

          <section className="panel">
            <div className="panel-heading">
              <h2>Insert</h2>
              <span>A4 canvas</span>
            </div>
            <div className="tool-grid">
              <button
                type="button"
                onClick={() => addItem(createShape("rectangle", 72, 140))}
              >
                Rectangle
              </button>
              <button
                type="button"
                onClick={() => addItem(createShape("square", 230, 140))}
              >
                Square
              </button>
              <button
                type="button"
                onClick={() => addItem(createShape("circle", 390, 140))}
              >
                Circle
              </button>
              <button
                type="button"
                onClick={() => addItem(createShape("oval", 540, 140))}
              >
                Oval
              </button>
              <button
                type="button"
                onClick={() => addItem(createShape("triangle", 72, 300))}
              >
                Triangle
              </button>
              <button
                type="button"
                onClick={() => addItem(createTextBox("text", 250, 300))}
              >
                Text Box
              </button>
              <button
                type="button"
                onClick={() => addItem(createTextBox("number", 500, 300))}
              >
                Number Box
              </button>
              <button
                type="button"
                onClick={() => assets[0] && addAssetToPage(assets[0])}
                disabled={assets.length === 0}
              >
                Asset
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <h2>Assets</h2>
              <span>{assetPanelStatus}</span>
            </div>
            <label
              className={`upload-button ${cloudConfigured && !cloudReady ? "disabled" : ""}`}
            >
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={handleAssetUpload}
                disabled={cloudConfigured && !cloudReady}
              />
              {assetBusy ? "Uploading..." : "Upload Images"}
            </label>
            <input
              className="search-input"
              type="search"
              placeholder="Search assets"
              value={assetSearch}
              onChange={(event) => setAssetSearch(event.target.value)}
            />
            <div className="asset-list">
              {filteredAssets.length === 0 ? (
                <p className="asset-empty">{assetEmptyMessage}</p>
              ) : (
                filteredAssets.map((asset) => (
                  <article key={asset.id} className="asset-card">
                    <img src={asset.dataUrl} alt={asset.name} />
                    <div>
                      <strong>{asset.name}</strong>
                      <span>
                        {asset.width} x {asset.height}
                      </span>
                    </div>
                    <div className="asset-card-actions">
                      <button
                        type="button"
                        onClick={() => addAssetToPage(asset)}
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => void deleteAssetFromLibrary(asset.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <h2>Worksheets</h2>
              <span>{worksheetPanelStatus}</span>
            </div>

            {cloudReady ? (
              <>
                <label>
                  Worksheet Name
                  <input
                    type="text"
                    value={worksheetName}
                    onChange={(event) => setWorksheetName(event.target.value)}
                    placeholder="Untitled worksheet"
                  />
                </label>
                <div className="panel-footer-actions worksheet-actions">
                  <button
                    type="button"
                    onClick={() => void saveWorksheetToCloud(false)}
                    disabled={cloudBusy}
                  >
                    {activeWorksheetId ? "Update" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void saveWorksheetToCloud(true)}
                    disabled={cloudBusy}
                  >
                    Save Copy
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void refreshCloudLibrary(true)}
                    disabled={cloudBusy}
                  >
                    Refresh
                  </button>
                </div>

                <div className="worksheet-list">
                  {savedWorksheets.length === 0 ? (
                    <p className="asset-empty">No saved worksheets yet.</p>
                  ) : (
                    savedWorksheets.map((worksheet) => (
                      <article
                        key={worksheet.id}
                        className={`worksheet-card ${activeWorksheetId === worksheet.id ? "active" : ""}`}
                      >
                        <div>
                          <strong>{worksheet.name}</strong>
                          <span>
                            {worksheet.itemCount} item
                            {worksheet.itemCount === 1 ? "" : "s"}
                          </span>
                          <span>
                            {new Date(worksheet.updatedAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="asset-card-actions">
                          <button
                            type="button"
                            onClick={() =>
                              void loadWorksheetFromCloud(worksheet.id)
                            }
                            disabled={cloudBusy}
                          >
                            Load
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => {
                              setActiveWorksheetId(worksheet.id);
                              setWorksheetName(worksheet.name);
                            }}
                            disabled={cloudBusy}
                          >
                            Select
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() =>
                              void removeWorksheetFromCloud(worksheet.id)
                            }
                            disabled={cloudBusy}
                          >
                            Delete
                          </button>
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </>
            ) : cloudConfigured ? (
              <div className="field-stack">
                <p className="plain-list">
                  Sign in above to save worksheets and keep assets scoped to an
                  account.
                </p>
                <p className="plain-list">
                  Bucket: {cloudPersistence.assetBucket}
                </p>
              </div>
            ) : (
              <div className="field-stack">
                <p className="plain-list">
                  Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env`
                  to enable durable saves.
                </p>
                <p className="plain-list">
                  Assets are resized before upload and deduplicated by content
                  hash to limit storage use in the backend bucket.
                </p>
                <p className="plain-list">
                  Bucket: {cloudPersistence.assetBucket}
                </p>
              </div>
            )}
          </section>
        </aside>

        <main
          className="stage"
          onPointerDown={(event) => {
            if (event.button !== 0) {
              return;
            }

            setContextMenu(null);

            if (event.target === event.currentTarget) {
              setSelectedIds([]);
            }
          }}
          onContextMenu={(event) => openContextMenu(event, "stage", null)}
        >
          <div className="stage-toolbar no-print">
            <span>
              Drag items on the page. Drag an empty area to multi-select. Use
              Ctrl/Cmd+C, Ctrl/Cmd+X, and Ctrl/Cmd+V for selection shortcuts.
              Double-click text or number boxes to edit.
            </span>
          </div>
          <div className="page-frame">
            <div
              className="page"
              ref={pageRef}
              onPointerDown={beginSelectionMarquee}
            >
              {items.map((item) => {
                const isSelected = selectedIdSet.has(item.id);
                const showResizeHandles = selectedItem?.id === item.id;
                const commonStyle = {
                  left: `${item.x}px`,
                  top: `${item.y}px`,
                  width: `${item.width}px`,
                  height: `${item.height}px`,
                  transform: `rotate(${item.rotation}deg)`,
                };

                return (
                  <div
                    key={item.id}
                    className={`page-item ${isSelected ? "selected" : ""} ${editingId === item.id ? "editing" : ""}`}
                    style={commonStyle}
                    onPointerDown={(event) => startMove(event, item)}
                    onContextMenu={(event) => {
                      if (editingId === item.id) {
                        return;
                      }

                      openContextMenu(event, "item", item.id);
                    }}
                    onDoubleClick={() => {
                      if (item.kind === "text") {
                        startInlineEditing(item.id);
                      }
                    }}
                  >
                    {item.kind === "shape" ? (
                      <div
                        className={`shape shape-${item.shapeType}`}
                        style={{
                          background: item.fill,
                          borderColor: item.stroke,
                          borderWidth: `${item.strokeWidth}px`,
                        }}
                      />
                    ) : null}

                    {item.kind === "text" ? (
                      editingId === item.id ? (
                        item.boxType === "number" ? (
                          <input
                            className={`text-item text-item-input box-${item.boxType}`}
                            type="number"
                            style={getTextItemStyle(item)}
                            value={item.content}
                            onPointerDown={(event) => event.stopPropagation()}
                            onChange={(event) =>
                              updateTextItemValue(item.id, event.target.value)
                            }
                            onBlur={stopInlineEditing}
                            onKeyDown={(event) => {
                              if (
                                event.key === "Enter" ||
                                event.key === "Escape"
                              ) {
                                event.currentTarget.blur();
                              }
                            }}
                            autoFocus
                          />
                        ) : (
                          <textarea
                            className={`text-item text-item-textarea box-${item.boxType}`}
                            style={getTextItemStyle(item)}
                            value={item.content}
                            onPointerDown={(event) => event.stopPropagation()}
                            onChange={(event) =>
                              updateTextItemValue(item.id, event.target.value)
                            }
                            onBlur={stopInlineEditing}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                event.currentTarget.blur();
                                stopInlineEditing();
                              }
                            }}
                            autoFocus
                          />
                        )
                      ) : (
                        <div
                          className={`text-item box-${item.boxType}`}
                          style={getTextItemStyle(item)}
                        >
                          <span>{item.content}</span>
                        </div>
                      )
                    ) : null}

                    {item.kind === "asset" ? (
                      <div className="asset-item">
                        <img
                          src={item.src}
                          alt={item.assetName}
                          style={{ objectFit: item.fit }}
                          draggable={false}
                        />
                      </div>
                    ) : null}

                    {showResizeHandles ? (
                      <>
                        <button
                          type="button"
                          className="resize-handle resize-nw"
                          onPointerDown={(event) =>
                            startResize(event, item, "nw")
                          }
                        />
                        <button
                          type="button"
                          className="resize-handle resize-ne"
                          onPointerDown={(event) =>
                            startResize(event, item, "ne")
                          }
                        />
                        <button
                          type="button"
                          className="resize-handle resize-sw"
                          onPointerDown={(event) =>
                            startResize(event, item, "sw")
                          }
                        />
                        <button
                          type="button"
                          className="resize-handle resize-se"
                          onPointerDown={(event) =>
                            startResize(event, item, "se")
                          }
                        />
                      </>
                    ) : null}
                  </div>
                );
              })}

              {selectedGroupBounds ? (
                <div
                  className="group-selection-frame"
                  style={{
                    left: `${selectedGroupBounds.left - 10}px`,
                    top: `${selectedGroupBounds.top - 10}px`,
                    width: `${selectedGroupBounds.width + 20}px`,
                    height: `${selectedGroupBounds.height + 20}px`,
                  }}
                />
              ) : null}

              {selectionBoxStyle ? (
                <div className="selection-box" style={selectionBoxStyle} />
              ) : null}
            </div>
          </div>
        </main>

        <aside className="inspector no-print">
          <section className="panel">
            <div className="panel-heading">
              <h2>Inspector</h2>
              <span>{selectionLabel}</span>
            </div>

            {selectedIds.length === 0 ? (
              <p className="asset-empty">
                Select any object to edit its properties.
              </p>
            ) : null}

            {selectedGroup ? (
              <div className="field-stack group-actions-panel">
                <div className="panel-heading panel-heading-compact">
                  <h3>Group Actions</h3>
                  <span>{selectedGroup.itemIds.length} items</span>
                </div>
                <p className="plain-list">
                  This selection is grouped and can be moved or ungrouped as a
                  set.
                </p>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => ungroupById(selectedGroup.id)}
                >
                  Ungroup
                </button>
              </div>
            ) : null}

            {selectedItem ? (
              <div className="field-stack">
                <label>
                  X
                  <NumberInput
                    value={selectedItem.x}
                    min={0}
                    max={PAGE_WIDTH - selectedItem.width}
                    onCommit={(nextValue) =>
                      updateSelectedItem((item) => ({
                        ...item,
                        x: nextValue,
                      }))
                    }
                  />
                </label>
                <label>
                  Y
                  <NumberInput
                    value={selectedItem.y}
                    min={0}
                    max={PAGE_HEIGHT - selectedItem.height}
                    onCommit={(nextValue) =>
                      updateSelectedItem((item) => ({
                        ...item,
                        y: nextValue,
                      }))
                    }
                  />
                </label>
                <label>
                  Width
                  <NumberInput
                    value={selectedItem.width}
                    min={getMinSize(selectedItem).width}
                    max={PAGE_WIDTH - selectedItem.x}
                    onCommit={(nextValue) =>
                      updateSelectedItem((item) => ({
                        ...item,
                        width: nextValue,
                      }))
                    }
                  />
                </label>
                <label>
                  Height
                  <NumberInput
                    value={selectedItem.height}
                    min={getMinSize(selectedItem).height}
                    max={PAGE_HEIGHT - selectedItem.y}
                    onCommit={(nextValue) =>
                      updateSelectedItem((item) => ({
                        ...item,
                        height: nextValue,
                      }))
                    }
                  />
                </label>
              </div>
            ) : null}

            {selectedItem?.kind === "shape" ? (
              <div className="field-stack">
                <label>
                  Shape
                  <select
                    value={selectedItem.shapeType}
                    onChange={(event) =>
                      updateSelectedItem((item) => ({
                        ...(item as ShapeItem),
                        shapeType: event.target.value as ShapeType,
                      }))
                    }
                  >
                    <option value="rectangle">Rectangle</option>
                    <option value="square">Square</option>
                    <option value="circle">Circle</option>
                    <option value="oval">Oval</option>
                    <option value="triangle">Triangle</option>
                  </select>
                </label>
                <label>
                  Fill
                  <ColorInput
                    label="Fill color"
                    value={selectedItem.fill}
                    onChange={(value) =>
                      updateSelectedItem((item) => ({
                        ...(item as ShapeItem),
                        fill: value,
                      }))
                    }
                  />
                </label>
                <label>
                  Stroke
                  <ColorInput
                    label="Stroke color"
                    value={selectedItem.stroke}
                    onChange={(value) =>
                      updateSelectedItem((item) => ({
                        ...(item as ShapeItem),
                        stroke: value,
                      }))
                    }
                  />
                </label>
                <label>
                  Stroke Width
                  <NumberInput
                    value={selectedItem.strokeWidth}
                    min={0}
                    max={12}
                    onCommit={(nextValue) =>
                      updateSelectedItem((item) => ({
                        ...(item as ShapeItem),
                        strokeWidth: nextValue,
                      }))
                    }
                  />
                </label>
              </div>
            ) : null}

            {selectedItem?.kind === "text" ? (
              <div className="field-stack">
                <label>
                  Box Type
                  <select
                    value={selectedItem.boxType}
                    onChange={(event) =>
                      updateSelectedItem((item) => {
                        const boxType = event.target.value as BoxType;

                        return {
                          ...(item as TextItem),
                          boxType,
                          ...getDefaultTextBoxAppearance(boxType),
                        };
                      })
                    }
                  >
                    <option value="text">Text</option>
                    <option value="number">Number</option>
                  </select>
                </label>
                <label>
                  Content
                  {selectedItem.boxType === "text" ? (
                    <textarea
                      rows={4}
                      value={selectedItem.content}
                      onChange={(event) =>
                        updateSelectedItem((item) => ({
                          ...(item as TextItem),
                          content: event.target.value,
                        }))
                      }
                    />
                  ) : (
                    <input
                      type="number"
                      value={selectedItem.content}
                      onChange={(event) =>
                        updateSelectedItem((item) => ({
                          ...(item as TextItem),
                          content: event.target.value,
                        }))
                      }
                    />
                  )}
                </label>
                <label>
                  Font Size
                  <NumberInput
                    value={selectedItem.fontSize}
                    min={12}
                    max={96}
                    onCommit={(nextValue) =>
                      updateSelectedItem((item) => ({
                        ...(item as TextItem),
                        fontSize: nextValue,
                      }))
                    }
                  />
                </label>
                <label>
                  Font Color
                  <ColorInput
                    label="Font color"
                    value={selectedItem.textColor}
                    onChange={(value) =>
                      updateSelectedItem((item) => ({
                        ...(item as TextItem),
                        textColor: value,
                      }))
                    }
                  />
                </label>
                <label>
                  Alignment
                  <select
                    value={selectedItem.align}
                    onChange={(event) =>
                      updateSelectedItem((item) => ({
                        ...(item as TextItem),
                        align: event.target.value as TextItem["align"],
                      }))
                    }
                  >
                    <option value="left">Left</option>
                    <option value="center">Center</option>
                    <option value="right">Right</option>
                  </select>
                </label>
                <div className="field-stack inline-two">
                  <label>
                    Background
                    <ColorInput
                      label="Background color"
                      value={selectedItem.backgroundColor}
                      onChange={(value) =>
                        updateSelectedItem((item) => ({
                          ...(item as TextItem),
                          backgroundColor: value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Border Color
                    <ColorInput
                      label="Border color"
                      value={selectedItem.borderColor}
                      onChange={(value) =>
                        updateSelectedItem((item) => ({
                          ...(item as TextItem),
                          borderColor: value,
                        }))
                      }
                    />
                  </label>
                </div>
                <div className="field-stack inline-two">
                  <label>
                    Border Width
                    <NumberInput
                      value={selectedItem.borderWidth}
                      min={0}
                      max={12}
                      onCommit={(nextValue) =>
                        updateSelectedItem((item) => ({
                          ...(item as TextItem),
                          borderWidth: nextValue,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Border Style
                    <select
                      value={selectedItem.borderStyle}
                      onChange={(event) =>
                        updateSelectedItem((item) => ({
                          ...(item as TextItem),
                          borderStyle: event.target.value as TextBorderStyle,
                        }))
                      }
                    >
                      <option value="solid">Solid</option>
                      <option value="dashed">Dashed</option>
                      <option value="dotted">Dotted</option>
                      <option value="none">None</option>
                    </select>
                  </label>
                </div>
              </div>
            ) : null}

            {selectedItem?.kind === "asset" ? (
              <div className="field-stack">
                <label>
                  Asset Name
                  <input type="text" value={selectedItem.assetName} readOnly />
                </label>
                <label>
                  Fit
                  <select
                    value={selectedItem.fit}
                    onChange={(event) =>
                      updateSelectedItem((item) => ({
                        ...(item as AssetItem),
                        fit: event.target.value as AssetItem["fit"],
                      }))
                    }
                  >
                    <option value="contain">Contain</option>
                    <option value="cover">Cover</option>
                  </select>
                </label>
              </div>
            ) : null}

            {selectedItem ? (
              <button
                type="button"
                className="danger"
                onClick={() => deleteItemsByIds(selectedIds)}
              >
                Delete Selection
              </button>
            ) : selectedIds.length > 1 ? (
              <button
                type="button"
                className="danger"
                onClick={() => deleteItemsByIds(selectedIds)}
              >
                Delete Selection
              </button>
            ) : null}
          </section>
        </aside>
      </div>

      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="context-menu no-print"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          role="menu"
          aria-label={
            contextMenu.scope === "group"
              ? "Group actions"
              : contextMenu.scope === "selection"
                ? "Selection actions"
                : contextMenu.scope === "item"
                  ? "Element actions"
                  : "Canvas actions"
          }
        >
          {contextMenu.scope !== "stage" ? (
            <>
              <button
                type="button"
                className="context-menu-button"
                onClick={() =>
                  runContextMenuAction(() =>
                    cutItemsByIds(contextTargetIds, contextMenu.groupId),
                  )
                }
              >
                Cut
              </button>
              <button
                type="button"
                className="context-menu-button"
                onClick={() =>
                  runContextMenuAction(() =>
                    copyItemsByIds(contextTargetIds, contextMenu.groupId),
                  )
                }
              >
                Copy
              </button>
              <button
                type="button"
                className="context-menu-button"
                onClick={() => runContextMenuAction(pasteClipboardItem)}
                disabled={!clipboardItem}
              >
                Paste
              </button>
              <div className="context-menu-separator" />
              <button
                type="button"
                className="context-menu-button"
                onClick={() =>
                  runContextMenuAction(() =>
                    moveSelection("forward", contextTargetIds),
                  )
                }
                disabled={
                  !canMoveItemsInLayer(items, contextTargetIds, "forward")
                }
              >
                Bring Forward
              </button>
              <button
                type="button"
                className="context-menu-button"
                onClick={() =>
                  runContextMenuAction(() =>
                    moveSelection("backward", contextTargetIds),
                  )
                }
                disabled={
                  !canMoveItemsInLayer(items, contextTargetIds, "backward")
                }
              >
                Send Backward
              </button>
              <button
                type="button"
                className="context-menu-button"
                onClick={() =>
                  runContextMenuAction(() =>
                    moveSelection("front", contextTargetIds),
                  )
                }
                disabled={
                  !canMoveItemsInLayer(items, contextTargetIds, "front")
                }
              >
                Bring to Front
              </button>
              <button
                type="button"
                className="context-menu-button"
                onClick={() =>
                  runContextMenuAction(() =>
                    moveSelection("back", contextTargetIds),
                  )
                }
                disabled={!canMoveItemsInLayer(items, contextTargetIds, "back")}
              >
                Send to Back
              </button>
              <div className="context-menu-separator" />
              {contextMenu.scope === "group" ? (
                <>
                  <button
                    type="button"
                    className="context-menu-button"
                    onClick={() =>
                      runContextMenuAction(() => {
                        if (contextMenu.groupId) {
                          ungroupById(contextMenu.groupId);
                        }
                      })
                    }
                  >
                    Ungroup
                  </button>
                  <div className="context-menu-separator" />
                </>
              ) : null}
              <button
                type="button"
                className="context-menu-button context-menu-button-danger"
                onClick={() =>
                  runContextMenuAction(() => deleteItemsByIds(contextTargetIds))
                }
              >
                Delete
              </button>
            </>
          ) : (
            <button
              type="button"
              className="context-menu-button"
              onClick={() => runContextMenuAction(pasteClipboardItem)}
              disabled={!clipboardItem}
            >
              Paste
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default App;
