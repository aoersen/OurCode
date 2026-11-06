import { describe, expect, it } from 'vitest'
import { brandIdentity } from '@/components/Layout/brand'

/**
 * 左上角标识回归：普通对话窗口与一人公司窗口必须是两套身份。
 * 之前两边共用「OurCode 一人公司」，主对话窗口也挂着「一人公司」，
 * 用户分不清自己当前在哪一边下指令。
 */
describe('左上角品牌标识随窗口模式切换', () => {
  it('普通对话窗口只显示产品名，不挂「一人公司」', () => {
    const brand = brandIdentity(false)
    expect(brand.mode).toBe('main')
    expect(brand.product).toBe('OurCode')
    expect(brand.modeName).toBe('')
    expect(brand.fullName).toBe('OurCode')
    expect(brand.mark).toBe('dot')
  })

  it('一人公司窗口用方章 + 「一人公司」后缀', () => {
    const brand = brandIdentity(true)
    expect(brand.mode).toBe('office')
    expect(brand.product).toBe('OurCode')
    expect(brand.modeName).toBe('一人公司')
    expect(brand.fullName).toBe('OurCode 一人公司')
    expect(brand.mark).toBe('seal')
  })

  it('两个模式的标识不共用同一形状或名称', () => {
    const main = brandIdentity(false)
    const office = brandIdentity(true)
    expect(main.mark).not.toBe(office.mark)
    expect(main.fullName).not.toBe(office.fullName)
  })
})
