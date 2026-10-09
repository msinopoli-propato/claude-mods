import type { Color } from 'claude-code'

import type { SessionStatusHealth } from '../types'

// One CIM round trip (~3s). Prints `cpu%|freeKB|totalKB|tenthsOfKelvin`; the thermal zone read needs no admin
// rights, unlike MSAcpi_ThermalZoneTemperature. Passed as one argv element: there is no shell to quote for.
const SCRIPT = [
  '$z=Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation',
  "$t=($z | Where-Object Name -like '*CPUZ*' | Select-Object -First 1).HighPrecisionTemperature",
  'if(-not $t){$t=($z | Measure-Object HighPrecisionTemperature -Maximum).Maximum}',
  '$c=(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average',
  '$o=Get-CimInstance Win32_OperatingSystem',
  "'{0}|{1}|{2}|{3}' -f $c,$o.FreePhysicalMemory,$o.TotalVisibleMemorySize,$t",
].join('; ')

export const HEALTH_ARGV = ['powershell', '-NoProfile', '-NonInteractive', '-Command', SCRIPT] as const

const KELVIN_OFFSET = 273.15

const number = (field: string | undefined) => {
  if (field === undefined || field.trim() === '') return undefined
  const value = Number(field)
  return Number.isFinite(value) ? value : undefined
}

// Returns null unless CPU and RAM both parse; a missing or implausible temperature only drops the temperature.
export const parseHealth = (stdout: string): SessionStatusHealth | null => {
  const [cpu, free, total, temp] = stdout.trim().split('|').map(field => field.trim())
  const cpuValue = number(cpu)
  const freeValue = number(free)
  const totalValue = number(total)
  if (cpuValue === undefined || freeValue === undefined || totalValue === undefined || totalValue <= 0) return null

  const tenthsKelvin = number(temp)
  return {
    cpu: Math.round(cpuValue),
    ram: Math.round(((totalValue - freeValue) / totalValue) * 100),
    tempC: tenthsKelvin !== undefined && tenthsKelvin > 0 ? Math.round(tenthsKelvin / 10 - KELVIN_OFFSET) : null,
  }
}

const level = (value: number, warning: number, error: number): Color =>
  value >= error ? 'error' : value >= warning ? 'warning' : 'success'

export const healthColors = ({ cpu, ram, tempC }: SessionStatusHealth) => ({
  cpu: level(cpu, 70, 90),
  ram: level(ram, 75, 90),
  temp: tempC === null ? undefined : level(tempC, 70, 85),
})
