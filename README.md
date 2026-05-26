# Maritime Debugger

Local debug and analysis tool for NMEA 0183 and NMEA 2000/CAN traffic.

## Run

```sh
node src/server.js
```

Open <http://localhost:8787>.

## Inputs

- NMEA 0183 text: `$..*hh` and `!..*hh` sentences from serial or replay text.
- CAN-over-serial SLCAN: `t...` and `T...` frames from serial or replay text.
- Raw text replay: paste a captured log into the UI.

## Serial Notes

The current no-dependency MVP configures serial ports through `stty` on macOS/Linux and then reads the device as a stream.

Common macOS ports look like:

```text
/dev/tty.usbserial-110
/dev/tty.usbmodem101
```

If your CAN interface does not output SLCAN lines, capture a few raw lines and add a new parser in `src/parsers.js`.
