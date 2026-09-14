/// <reference types="@tarojs/taro" />

declare module '*.png'
declare module '*.gif'
declare module '*.jpg'
declare module '*.jpeg'
declare module '*.svg'
declare module '*.css'
declare module '*.scss'
declare module '*.sass'

declare namespace NodeJS {
  interface ProcessEnv {
    /** Node 内置环境变量，影响构建产物 */
    NODE_ENV: 'development' | 'production'
    /** 当前构建平台 */
    TARO_ENV: 'weapp' | 'h5'
    /** 小程序 AppID，可通过 .env 的 TARO_APP_ID 切换 */
    TARO_APP_ID: string
  }
}
