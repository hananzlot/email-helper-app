import { drive_v3 } from 'googleapis';
import { Readable } from 'stream';

const BACKUP_FOLDER_NAME = 'Email Helper Backups';

/**
 * Find or create the backup folder in Google Drive.
 * Returns the folder ID.
 */
export async function ensureBackupFolder(drive: drive_v3.Drive): Promise<string> {
  // Search for existing folder
  const res = await drive.files.list({
    q: `name='${BACKUP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id!;
  }

  // Create folder
  const folder = await drive.files.create({
    requestBody: {
      name: BACKUP_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });

  return folder.data.id!;
}

/**
 * Upload an MBOX file to the backup folder.
 * Uses resumable upload for reliability with large files.
 */
export async function uploadMboxFile(
  drive: drive_v3.Drive,
  folderId: string,
  fileName: string,
  data: Buffer
): Promise<string> {
  const stream = Readable.from(data);

  const file = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      mimeType: 'application/mbox',
    },
    media: {
      mimeType: 'application/mbox',
      body: stream,
    },
    fields: 'id, webViewLink',
  });

  return file.data.id!;
}

/**
 * List existing backup files in the backup folder.
 */
export async function listBackupFiles(drive: drive_v3.Drive, folderId: string) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id, name, size, createdTime)',
    orderBy: 'createdTime desc',
  });

  return res.data.files || [];
}

/**
 * Test if Drive scope is authorized by making a lightweight API call.
 */
export async function testDriveAccess(drive: drive_v3.Drive): Promise<boolean> {
  try {
    await drive.about.get({ fields: 'user' });
    return true;
  } catch {
    return false;
  }
}
