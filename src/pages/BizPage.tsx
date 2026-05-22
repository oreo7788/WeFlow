import React, { useState } from 'react'
import { BizAccountList } from './Biz/BizAccountList'
import { BizMessageArea } from './Biz/BizMessageArea'
import type { BizAccount } from './Biz/types'
import './BizPage.scss'

export type { BizAccount } from './Biz/types'
export { BizAccountList } from './Biz/BizAccountList'
export { BizMessageArea } from './Biz/BizMessageArea'

const BizPage: React.FC = () => {
  const [selectedAccount, setSelectedAccount] = useState<BizAccount | null>(null)
  return (
    <div className="biz-page">
      <div className="biz-sidebar">
        <BizAccountList onSelect={setSelectedAccount} selectedUsername={selectedAccount?.username} />
      </div>
      <BizMessageArea account={selectedAccount} />
    </div>
  )
}

export default BizPage
