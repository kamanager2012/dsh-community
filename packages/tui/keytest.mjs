import { render, Text, Box, useInput } from 'ink'
import { createElement, useState } from 'react'
import React from 'react'

function Probe() {
  const [log, setLog] = useState('waiting')
  useInput((input, key) => {
    setLog(`got input=${JSON.stringify(input)} key=${JSON.stringify(key)}`)
    process.stderr.write(`KEY: ${JSON.stringify(input)}\n`)
  })
  return createElement(Box, null, createElement(Text, null, log))
}

render(createElement(Probe))
process.stderr.write('READY isTTY=' + process.stdin.isTTY + '\n')
