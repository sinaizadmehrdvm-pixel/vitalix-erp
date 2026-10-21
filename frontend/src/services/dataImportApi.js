import { API_URL, getAuthHeaders } from "./api";

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${API_URL}/api/data-import${path}`, {
    ...options,
    headers: getAuthHeaders(options.headers),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.detail || data?.message || `API error ${response.status}`);
  return data;
}

async function requestBlob(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: getAuthHeaders(options.headers, true),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || data?.message || `API error ${response.status}`);
  }
  return response.blob();
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function inspectImportFile(file, entity = "products", sheetName = "") {
  const body = new FormData();
  body.append("file", file);
  body.append("entity", entity);
  if (sheetName) body.append("sheet_name", sheetName);
  const response = await fetch(`${API_URL}/api/data-import/inspect`, {
    method: "POST",
    headers: getAuthHeaders({}, false),
    body,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.detail || `API error ${response.status}`);
  return data;
}

// options: { opening_date, sheet_name, column_map_json, duplicate_policy,
// match_keys, negative_stock_policy, default_warehouse_id, update_fields,
// allow_blank_overwrite } - all optional, only meaningful for "products".
export async function previewImport(entity, file, options = {}) {
  const body = new FormData();
  body.append("file", file);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === "") continue;
    body.append(key, typeof value === "boolean" ? String(value) : value);
  }
  const response = await fetch(`${API_URL}/api/data-import/preview/${entity}`, {
    method: "POST",
    headers: getAuthHeaders({}, false),
    body,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.detail || `API error ${response.status}`);
  return data;
}

export const applyImport = (batchId) => jsonRequest(`/apply/${batchId}`, { method: "POST" });
export const rollbackImportBatch = (batchId) => jsonRequest(`/rollback/${batchId}`, { method: "POST" });
export const getImportBatches = () => jsonRequest("/batches");
export const deleteImportBatch = (batchId) => jsonRequest(`/batches/${batchId}`, { method: "DELETE" });

export const getMappingProfiles = (entity) => jsonRequest(`/mapping-profiles?entity=${encodeURIComponent(entity)}`);
export const saveMappingProfile = (entityType, name, mapping) =>
  jsonRequest("/mapping-profiles", {
    method: "POST",
    body: JSON.stringify({ entity_type: entityType, name, mapping }),
  });

export async function downloadImportTemplate(entity, language) {
  const response = await fetch(`${API_URL}/api/data-import/template/${entity}?language=${language}`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail || "Template download failed");
  const blob = await response.blob();
  triggerBlobDownload(blob, `vetrix_${entity}_import_${language}.xlsx`);
}

export async function exportImportReportExcel(batchId, scope, filename) {
  const blob = await requestBlob(`/export/import-report/${batchId}/${scope}-excel`, { method: "POST" });
  triggerBlobDownload(blob, filename || `vetrix-import-${scope}.xlsx`);
}

export async function exportImportReportSummaryPdf(batchId, filename) {
  const blob = await requestBlob(`/export/import-report/${batchId}/summary-pdf`, { method: "POST" });
  triggerBlobDownload(blob, filename || "vetrix-import-summary.pdf");
}


// PARASAY existing-customer opening: never uses the normal customers insert path.
export async function previewExistingCustomerOpening(file) {
  const body = new FormData();
  body.append("file", file);
  const response = await fetch(`${API_URL}/api/data-import/customer-opening/preview`, {
    method: "POST",
    headers: getAuthHeaders({}, false),
    body,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.detail || "Opening preview failed");
  return result;
}
export const applyExistingCustomerOpening = (batchId) =>
  jsonRequest(`/customer-opening/apply/${encodeURIComponent(batchId)}?confirm=APPLY_1405_07_29`, { method: "POST" });
