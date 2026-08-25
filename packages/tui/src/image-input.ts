import { readFile, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  AttachmentStoreLike,
  ImageMediaTypeLike,
  SaveImageAttachmentLike,
} from './types.js'

const IMAGE_COMMAND = '/image'

const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, ImageMediaTypeLike>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export interface ParsedImageCommand {
  readonly paths: readonly string[]
  readonly prompt: string
}

export interface BuiltUserContent {
  readonly content: ContentBlock[]
  readonly imageCount: number
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value)
}

function findPromptSeparator(value: string): number {
  let quote: '"' | "'" | undefined
  for (let index = 0; index < value.length - 1; index += 1) {
    const ch = value[index]
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (
      ch === '-'
      && value[index + 1] === '-'
      && (index === 0 || isWhitespace(value[index - 1]))
      && (index + 2 === value.length || isWhitespace(value[index + 2]))
    ) {
      return index
    }
  }
  return -1
}

function tokenizePaths(value: string): string[] {
  const paths: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined

  const push = (): void => {
    if (current !== '') paths.push(current)
    current = ''
  }

  for (const ch of value) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/u.test(ch)) {
      push()
      continue
    }
    current += ch
  }

  if (quote !== undefined) throw new Error('图片路径引号未闭合')
  push()
  return paths
}

export function parseImageCommand(input: string): ParsedImageCommand | undefined {
  if (
    input !== IMAGE_COMMAND
    && !input.startsWith(`${IMAGE_COMMAND} `)
    && !input.startsWith(`${IMAGE_COMMAND}\t`)
  ) {
    return undefined
  }

  const body = input.slice(IMAGE_COMMAND.length).trim()
  if (body === '') {
    throw new Error('用法：/image "图片路径" ["更多图片"] -- 可选提示词')
  }

  const separator = findPromptSeparator(body)
  const pathPart = (separator < 0 ? body : body.slice(0, separator)).trim()
  const prompt = separator < 0 ? '' : body.slice(separator + 2).trim()
  const paths = tokenizePaths(pathPart)

  if (paths.length === 0) {
    throw new Error('至少提供一张图片路径')
  }

  return { paths, prompt }
}

function mediaTypeForPath(path: string): ImageMediaTypeLike {
  const mediaType = MEDIA_TYPE_BY_EXTENSION[extname(path).toLowerCase()]
  if (mediaType === undefined) {
    throw new Error(`不支持的图片扩展名：${extname(path) || '(无扩展名)'}`)
  }
  return mediaType
}

async function prepareImages(
  paths: readonly string[],
  attachments: AttachmentStoreLike,
  cwd: string,
): Promise<readonly SaveImageAttachmentLike[]> {
  const { imageLimits } = attachments
  if (paths.length > imageLimits.maxImagesPerMessage) {
    throw new Error(`单条消息最多 ${String(imageLimits.maxImagesPerMessage)} 张图片`)
  }

  const pending: Array<{
    readonly absolutePath: string
    readonly displayPath: string
    readonly mediaType: ImageMediaTypeLike
    readonly bytes: number
  }> = []

  let aggregateBytes = 0
  for (const path of paths) {
    const absolutePath = resolve(cwd, path)
    const mediaType = mediaTypeForPath(absolutePath)
    if (!imageLimits.mediaTypes.includes(mediaType)) {
      throw new Error(`当前运行时不接受 ${mediaType} 图片`)
    }

    let file
    try {
      file = await stat(absolutePath)
    } catch (error) {
      throw new Error(`无法读取图片：${path}`, { cause: error })
    }
    if (!file.isFile()) throw new Error(`图片路径不是文件：${path}`)
    if (file.size > imageLimits.maxImageBytes) {
      throw new Error(
        `图片 ${basename(path)} 超过单图限制 ${String(imageLimits.maxImageBytes)} bytes`,
      )
    }

    aggregateBytes += file.size
    if (aggregateBytes > imageLimits.maxMessageImageBytes) {
      throw new Error(
        `图片总大小超过单条消息限制 ${String(imageLimits.maxMessageImageBytes)} bytes`,
      )
    }

    pending.push({
      absolutePath,
      displayPath: path,
      mediaType,
      bytes: file.size,
    })
  }

  return Promise.all(pending.map(async (item) => {
    let data: Uint8Array
    try {
      data = await readFile(item.absolutePath)
    } catch (error) {
      throw new Error(`无法读取图片：${item.displayPath}`, { cause: error })
    }
    if (data.byteLength !== item.bytes) {
      throw new Error(`图片在读取期间发生变化：${item.displayPath}`)
    }
    return {
      data,
      mediaType: item.mediaType,
      name: basename(item.absolutePath),
    }
  }))
}

/**
 * Convert terminal input into the exact provider-neutral content blocks consumed
 * by official DSH. Plain text stays untouched. `/image` inputs are read locally,
 * committed through `ctx.attachments.saveImages()`, and only the returned
 * durable references enter the session message.
 */
export async function buildUserContent(
  input: string,
  attachments: AttachmentStoreLike,
  cwd = process.cwd(),
): Promise<BuiltUserContent> {
  const command = parseImageCommand(input)
  if (command === undefined) {
    return {
      content: [{ type: 'text', text: input }],
      imageCount: 0,
    }
  }

  const images = await prepareImages(command.paths, attachments, cwd)
  const refs = await attachments.saveImages(images)
  if (refs.length !== images.length) {
    throw new Error('官方 attachment store 返回的图片引用数量不一致')
  }

  const content: ContentBlock[] = []
  if (command.prompt !== '') content.push({ type: 'text', text: command.prompt })
  for (const attachment of refs) content.push({ type: 'image', attachment })

  return { content, imageCount: refs.length }
}
