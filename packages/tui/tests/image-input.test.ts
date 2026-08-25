import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildUserContent, parseImageCommand } from '../src/image-input.js'
import type {
  AttachmentStoreLike,
  ImageAttachmentRefLike,
  SaveImageAttachmentLike,
} from '../src/types.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-community-tui-image-'))
  tempDirs.push(dir)
  return dir
}

function attachmentStore() {
  const saved: SaveImageAttachmentLike[][] = []
  const store: AttachmentStoreLike = {
    imageLimits: {
      maxImageBytes: 1024 * 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 2 * 1024 * 1024,
      maxImagePixels: 10_000_000,
      maxImageDimension: 8192,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    async saveImages(inputs) {
      saved.push([...inputs])
      return inputs.map((input, index) => ({
        attachmentId: `test-${String(index)}` as never,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
        ...(input.name === undefined ? {} : { name: input.name }),
      }) as ImageAttachmentRefLike)
    },
  }
  return { store, saved }
}

describe('TUI rc.2 image input', () => {
  it('leaves ordinary text on the existing text-only path', async () => {
    const { store, saved } = attachmentStore()
    const built = await buildUserContent('只发文字', store)
    expect(built).toEqual({
      content: [{ type: 'text', text: '只发文字' }],
      imageCount: 0,
    })
    expect(saved).toEqual([])
  })

  it('parses quoted paths and preserves optional prompt text', () => {
    expect(parseImageCommand('/image "a b.png" c.webp -- 比较这两张图')).toEqual({
      paths: ['a b.png', 'c.webp'],
      prompt: '比较这两张图',
    })
    expect(parseImageCommand('/imagery not-a-command')).toBeUndefined()
  })

  it('maps PNG, JPEG and WebP files into official image blocks in order', async () => {
    const dir = await fixtureDir()
    await writeFile(join(dir, 'a.png'), Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))
    await writeFile(join(dir, 'b.jpeg'), Uint8Array.from([0xff, 0xd8, 0xff]))
    await writeFile(join(dir, 'c.webp'), Uint8Array.from([0x52, 0x49, 0x46, 0x46]))

    const { store, saved } = attachmentStore()
    const built = await buildUserContent(
      '/image a.png b.jpeg c.webp -- 看一下差异',
      store,
      dir,
    )

    expect(saved).toHaveLength(1)
    expect(saved[0]?.map((item) => [item.mediaType, item.name])).toEqual([
      ['image/png', 'a.png'],
      ['image/jpeg', 'b.jpeg'],
      ['image/webp', 'c.webp'],
    ])
    expect(built.imageCount).toBe(3)
    expect(built.content[0]).toEqual({ type: 'text', text: '看一下差异' })
    expect(built.content.slice(1).map((block) => block.type)).toEqual([
      'image',
      'image',
      'image',
    ])
  })

  it('supports an image-only user message', async () => {
    const dir = await fixtureDir()
    await writeFile(join(dir, 'only.png'), Uint8Array.from([1, 2, 3]))
    const { store } = attachmentStore()

    const built = await buildUserContent('/image only.png', store, dir)

    expect(built.content).toHaveLength(1)
    expect(built.content[0]?.type).toBe('image')
  })

  it('rejects unsupported inputs before the official store is called', async () => {
    const dir = await fixtureDir()
    await writeFile(join(dir, 'bad.bmp'), Uint8Array.from([1, 2, 3]))
    const { store, saved } = attachmentStore()

    await expect(buildUserContent('/image bad.bmp -- inspect', store, dir))
      .rejects.toThrow(/不支持的图片扩展名/)
    expect(saved).toEqual([])
  })

  it('rejects an over-limit batch before reading/committing it', async () => {
    const dir = await fixtureDir()
    for (const name of ['1.png', '2.png', '3.png', '4.png', '5.png']) {
      await writeFile(join(dir, name), Uint8Array.from([1]))
    }
    const { store, saved } = attachmentStore()

    await expect(
      buildUserContent('/image 1.png 2.png 3.png 4.png 5.png', store, dir),
    ).rejects.toThrow(/最多 4 张图片/)
    expect(saved).toEqual([])
  })

  it('surfaces official attachment-store admission failures', async () => {
    const dir = await fixtureDir()
    await writeFile(join(dir, 'bad.webp'), Uint8Array.from([1, 2, 3]))
    const { store } = attachmentStore()
    store.saveImages = async () => {
      throw new Error('UNSUPPORTED_IMAGE_TYPE')
    }

    await expect(buildUserContent('/image bad.webp', store, dir))
      .rejects.toThrow('UNSUPPORTED_IMAGE_TYPE')
  })
})
