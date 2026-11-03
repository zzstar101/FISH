import { Text, View } from '@tarojs/components'
import { readAppMeta } from '@/lib/app-meta'
import './index.scss'

export default function AppVersion() {
  const { version, environment } = readAppMeta()
  return (
    <View className="app-version">
      <Text className="app-version__number num">{version}</Text>
      {environment ? <Text className="app-version__env">{environment}</Text> : null}
    </View>
  )
}
