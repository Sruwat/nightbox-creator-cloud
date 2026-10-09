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

  return <section className="card creator-storage">
    <div className="card-head">
      <div><b>Cloud files</b><span>2 GiB included storage · admins can extend it to 3 GiB</span></div>
      <label className="btn btn-primary creator-storage-upload">{busy ? "Uploading…" : "Upload files"}<input type="file" multiple disabled={busy} onChange={uploadFiles} /></label>
    </div>
    {storage && <div className="creator-storage-usage" aria-label="Storage usage">
      <div><b>{prettySize(storage.usedBytes + storage.reservedBytes)} used</b><span>{prettySize(storage.quotaBytes)} quota</span></div>
      <i><em style={{ width: `${Math.min(100, (storage.usedBytes + storage.reservedBytes) / storage.quotaBytes * 100)}%` }} /></i>
    </div>}
    <div className="creator-storage-toolbar">
      <nav aria-label="Folder path"><button onClick={() => setFolderId(null)}>My files</button>{breadcrumbs.map((folder) => <button key={folder.id} onClick={() => setFolderId(folder.id)}>› {folder.name}</button>)}</nav>
      <form onSubmit={createFolder}><input aria-label="New folder name" value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="New folder name" maxLength={100}/><button className="btn btn-dark" type="submit">Create folder</button></form>
    </div>
    {error && <p className="empty-copy" role="status">{error}</p>}
    <div className="creator-storage-list">
      {visibleFolders.map((folder) => <article key={folder.id}>
        <button className="creator-storage-open" onClick={() => setFolderId(folder.id)}><span aria-hidden="true">▰</span><b>{folder.name}</b></button>
        <button onClick={() => void renameFolder(folder)}>Rename</button>
        <button onClick={() => void removeFolder(folder)}>Delete</button>
      </article>)}
      {files.map((file) => <article key={file.id}>
        <span className="creator-storage-name"><span aria-hidden="true">▤</span><b title={file.name}>{file.name}<small>{prettySize(file.sizeBytes)} · {file.mimeType}</small></b></span>
        <select aria-label={`Move ${file.name}`} value={file.folderId || ""} onChange={(event) => void moveFile(file, event.target.value)}>
          <option value="">Root</option>
          {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </select>
        <button onClick={() => void shareFile(file)}>{file.shareUrl ? "Copy share link" : "Create share link"}</button>
        {file.shareUrl && <><a href={file.shareUrl}>Download</a><button onClick={() => void revokeShare(file)}>Revoke link</button></>}
        <button onClick={() => void removeFile(file)}>Delete</button>
      </article>)}
      {!visibleFolders.length && !files.length && !error && <p className="empty-copy">This folder is empty. Upload a file or create a folder to get started.</p>}
    </div>
    <small className="creator-storage-private">Files are private until you create a share link. Anyone with a share link can access that file. Each file is limited by your remaining quota, up to 3 GiB.</small>
  </section>;
}
