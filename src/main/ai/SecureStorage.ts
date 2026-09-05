import { safeStorage } from 'electron'
import { logError } from '../errorLog'

/**
 * Utility to securely encrypt and decrypt strings (like API keys) 
 * using Electron's native safeStorage API.
 * The encrypted buffers are converted to base64 strings for easy JSON storage.
 */

export function encryptString(plaintext: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) {
    return null
  }
  const buffer = safeStorage.encryptString(plaintext)
  return buffer.toString('base64')
}

export function decryptString(encryptedBase64: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) {
    return null
  }
  try {
    const buffer = Buffer.from(encryptedBase64, 'base64')
    return safeStorage.decryptString(buffer)
  } catch (error: unknown) {
    logError('main:safeStorage', `Failed to decrypt string: ${String(error)}`)
    return null
  }
}
