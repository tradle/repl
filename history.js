'use strict'

const path = require('path')
const fs = require('fs')

module.exports = function history (server, historyPath) {
  historyPath = historyPath || path.join(process.env.HOME, '.tradle_repl_history')

  if (fs.existsSync(historyPath)) {
    fs.readFileSync(historyPath, { encoding: 'utf8' })
      .split('\n')
      .reverse()
      .filter(line => line.trim())
      .forEach(line => server.history.push(line))
  }

  server.on('exit', function () {
    // don't dedupe
    // history might be used as a build script later
    //
    // const deduped = []
    // server.lines.forEach(line => {
    //   if (line !== deduped[deduped.length - 1]) {
    //     deduped.push(line)
    //   }
    // })

    fs.appendFileSync(historyPath, '\n' + server.lines.join('\n'), { encoding: 'utf8' })
  })
}
