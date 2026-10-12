import { useEffect, useState } from "react";
import {
  createCreatorFolder,
  deleteCreatorFile,
  deleteCreatorFolder,
  getCreatorFiles,
  getCreatorFolders,
  moveCreatorFile,
  renameCreatorFolder,
  revokeCreatorFileShare,
  shareCreatorFile,
  uploadCreatorFile,
  type CreatorFolder,
  type CreatorStoredFile,
  type CreatorStorageUsage,
} from "./backend-api";

function prettySize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = units[0];
  for (let index = 1; size >= 1024 && index < units.length; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size.toFixed(1)} ${unit}`;
}

export default function CreatorFileManager({ token, toast }: { token: string; toast: (message: string) => void }) {
  const [folders, setFolders] = useState<CreatorFolder[]>([]);
  const [files, setFiles] = useState<CreatorStoredFile[]>([]);
  const [storage, setStorage] = useState<CreatorStorageUsage | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [folderResult, fileResult] = await Promise.all([
        getCreatorFolders(token),
        getCreatorFiles(token, folderId),
      ]);
      setFolders(folderResult.folders);
      setFiles(fileResult.files);
      setStorage(fileResult.storage);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Storage could not be loaded");
    }
  }

  useEffect(() => {
    let active = true;
    void Promise.all([getCreatorFolders(token), getCreatorFiles(token, folderId)])
      .then(([folderResult, fileResult]) => {
        if (!active) return;
        setFolders(folderResult.folders);
        setFiles(fileResult.files);
        setStorage(fileResult.storage);
        setError("");
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Storage could not be loaded");
      });
    return () => { active = false; };
  }, [token, folderId]);

  const folderMap = new Map(folders.map((folder) => [folder.id, folder]));
  const breadcrumbs: CreatorFolder[] = [];
  let ancestorId = folderId;
  while (ancestorId && folderMap.has(ancestorId)) {
    const folder = folderMap.get(ancestorId)!;
    breadcrumbs.unshift(folder);
    ancestorId = folder.parentId;
  }
  const visibleFolders = folders.filter((folder) => folder.parentId === folderId);

  async function createFolder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = folderName.trim();
    if (!name) return;
    try {
      await createCreatorFolder(token, name, folderId);
      setFolderName("");
      await load();
      toast("Folder created");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Folder could not be created");
    }
  }

  async function uploadFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const selected = Array.from(input.files || []);
    if (!selected.length) return;
    setBusy(true);
    try {
      for (const file of selected) await uploadCreatorFile(token, file, folderId);
      await load();
      toast(`${selected.length} file${selected.length === 1 ? "" : "s"} uploaded`);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "File upload failed");
      await load();
    } finally {
      setBusy(false);
      input.value = "";
    }
  }

  async function renameFolder(folder: CreatorFolder) {
    const name = window.prompt("New folder name", folder.name)?.trim();
    if (!name || name === folder.name) return;
    try {
      await renameCreatorFolder(token, folder.id, name);
      await load();
      toast("Folder renamed");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Folder could not be renamed");
    }
  }

  async function removeFolder(folder: CreatorFolder) {
    if (!window.confirm(`Delete the empty folder “${folder.name}”?`)) return;
    try {
      await deleteCreatorFolder(token, folder.id);
      await load();
      toast("Folder deleted");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Folder could not be deleted");
    }
  }

  async function shareFile(file: CreatorStoredFile) {
    try {
      const result = await shareCreatorFile(token, file.id);
      await navigator.clipboard.writeText(result.shareUrl);
      await load();
      toast("Share link copied");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Share link could not be created");
    }
  }

  async function revokeShare(file: CreatorStoredFile) {
    try {
      await revokeCreatorFileShare(token, file.id);
      await load();
      toast("Share link revoked");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Share link could not be revoked");
    }
  }

  async function moveFile(file: CreatorStoredFile, nextFolderId: string) {
    try {
      await moveCreatorFile(token, file.id, nextFolderId || null);
      await load();
      toast("File moved");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "File could not be moved");
    }
  }

  async function removeFile(file: CreatorStoredFile) {
    if (!window.confirm(`Permanently delete “${file.name}” from storage?`)) return;
    try {
      await deleteCreatorFile(token, file.id);
      await load();
      toast("File deleted");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "File could not be deleted");
    }
  }

  const usedBytes = (storage?.usedBytes || 0) + (storage?.reservedBytes || 0);
  const quotaBytes = storage?.quotaBytes || 1;
  const usagePercent = Math.min(100, usedBytes / quotaBytes * 100);
  const availableBytes = Math.max(0, quotaBytes - usedBytes);

  return <section className="card creator-storage">
    <div className="creator-storage-hero">
      <div className="creator-storage-heading">
        <span className="creator-storage-kicker">PRIVATE CLOUD LIBRARY</span>
        <h2>My files</h2>
        <p>Keep your uploads organised, private, and ready to share from one calm workspace.</p>
      </div>
      <label className="btn btn-primary creator-storage-upload">
        <span className="creator-storage-upload-icon" aria-hidden="true">↑</span>
        <span>{busy ? "Uploading…" : "Upload files"}</span>
        <input type="file" multiple disabled={busy} onChange={uploadFiles} />
      </label>
    </div>

    {storage && <div className="creator-storage-overview" aria-label="Storage summary">
      <div className="creator-storage-stat creator-storage-stat-wide">
        <div className="creator-storage-stat-top"><span>Storage used</span><b>{prettySize(usedBytes)} <small>of {prettySize(quotaBytes)}</small></b></div>
        <div className="creator-storage-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usagePercent)} aria-label={`${Math.round(usagePercent)} percent of storage used`}><i style={{ width: `${usagePercent}%` }} /></div>
        <small>{prettySize(availableBytes)} remaining</small>
      </div>
      <div className="creator-storage-stat"><span>Files here</span><b>{files.length}</b><small>stored uploads</small></div>
      <div className="creator-storage-stat"><span>Folders here</span><b>{visibleFolders.length}</b><small>organise your work</small></div>
    </div>}

    <div className="creator-storage-toolbar">
      <div className="creator-storage-location">
        <span className="creator-storage-location-label">LOCATION</span>
        <nav aria-label="Folder path"><button onClick={() => setFolderId(null)}>My files</button>{breadcrumbs.map((folder) => <button key={folder.id} onClick={() => setFolderId(folder.id)}>› {folder.name}</button>)}</nav>
      </div>
      <form onSubmit={createFolder} className="creator-storage-folder-form"><input aria-label="New folder name" value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="New folder name" maxLength={100}/><button className="btn btn-dark" type="submit">+ Create folder</button></form>
    </div>

    {error && <div className="creator-storage-error" role="status"><span aria-hidden="true">!</span><div><b>Storage could not be loaded</b><small>{error}</small></div><button onClick={() => void load()}>Try again</button></div>}
    <div className="creator-storage-list" aria-live="polite">
      {(visibleFolders.length > 0 || files.length > 0) && <div className="creator-storage-list-label"><span>NAME</span><span>ACTIONS</span></div>}
      {visibleFolders.map((folder) => <article className="creator-storage-item creator-storage-folder" key={folder.id}>
        <button className="creator-storage-open" onClick={() => setFolderId(folder.id)}><span className="creator-storage-item-icon folder" aria-hidden="true">▰</span><span className="creator-storage-item-copy"><b>{folder.name}</b><small>Folder · open to view contents</small></span></button>
        <div className="creator-storage-actions"><button onClick={() => void renameFolder(folder)}>Rename</button><button className="storage-danger" onClick={() => void removeFolder(folder)}>Delete</button></div>
      </article>)}
      {files.map((file) => <article className="creator-storage-item creator-storage-file" key={file.id}>
        <span className="creator-storage-name"><span className="creator-storage-item-icon file" aria-hidden="true">▤</span><span className="creator-storage-item-copy"><b title={file.name}>{file.name}</b><small>{prettySize(file.sizeBytes)} · {file.mimeType}</small></span></span>
        <div className="creator-storage-actions">
          <select aria-label={`Move ${file.name}`} value={file.folderId || ""} onChange={(event) => void moveFile(file, event.target.value)}><option value="">Move to root</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>
          <button onClick={() => void shareFile(file)}>{file.shareUrl ? "Copy link" : "Share file"}</button>
          {file.shareUrl && <><a href={file.shareUrl}>Download</a><button onClick={() => void revokeShare(file)}>Revoke</button></>}
          <button className="storage-danger" onClick={() => void removeFile(file)}>Delete</button>
        </div>
      </article>)}
      {!visibleFolders.length && !files.length && !error && <div className="creator-storage-empty"><span className="creator-storage-empty-icon" aria-hidden="true">▤</span><h3>This folder is ready for its first upload</h3><p>Upload a file or create a folder to start building your private library.</p><label className="btn btn-outline">Choose files<input type="file" multiple disabled={busy} onChange={uploadFiles} /></label></div>}
    </div>
    <div className="creator-storage-private"><span aria-hidden="true">◉</span><small>Files stay private until you create a share link. Each file can be up to 2 GiB and uses your remaining quota.</small></div>
  </section>;
}
