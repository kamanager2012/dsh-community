import { describe, expect, it } from 'vitest'
import { createStore } from '../src/store.js'

describe('TUI image session history', () => {
  it('renders durable image references after a resumed session event is replayed', () => {
    const store = createStore()
    store.applySessionEvent({
      log: [{
        type: 'user/message',
        seq: 8,
        data: {
          message: {
            source: { kind: 'user' },
            content: [
              { type: 'text', text: '这张图是什么？' },
              {
                type: 'image',
                attachment: {
                  attachmentId: 'sha256:test',
                  mediaType: 'image/png',
                  bytes: 123,
                  width: 640,
                  height: 480,
                  name: 'scene.png',
                },
              },
            ],
          },
        },
      }],
    })

    expect(store.state.items).toEqual([{
      kind: 'user',
      id: '8',
      text: '这张图是什么？\n[图片: scene.png 640×480]',
    }])
  })

  it('keeps image-only messages visible and dedupes replayed seq values', () => {
    const store = createStore()
    const event = {
      type: 'user/message',
      seq: 11,
      data: {
        content: [{
          type: 'image',
          attachment: {
            attachmentId: 'sha256:image-only',
            mediaType: 'image/webp',
            bytes: 55,
            width: 32,
            height: 32,
          },
        }],
        source: { kind: 'user' },
      },
    }

    store.applySessionEvent({ log: [event] })
    store.applySessionEvent({ log: [event] })

    expect(store.state.items).toEqual([{
      kind: 'user',
      id: '11',
      text: '[图片 32×32]',
    }])
  })
})
