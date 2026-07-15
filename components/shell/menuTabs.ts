import type { Tab } from './TabsContext'

/** 사이드바 메뉴와 1:1로 대응하는 탭의 "기본(목록) 상태" — 상세보기는 이 탭의 id를 그대로 재사용해 type/params만
 *  바꿔 넣는다. 탭 개수가 메뉴 개수로 고정되도록, 레코드별 상세를 열 때 새 탭을 만들지 않기 위함이다. */
export const CLIENTS_LIST_TAB: Tab = { id: 'clients-list', type: 'clients-list', title: '거래처 관리', icon: '🏢', closable: true }
export const SITES_LIST_TAB: Tab = { id: 'sites-list', type: 'sites-list', title: 'Mall 상세관리', icon: '📋', closable: true }
export const MASTER_LIST_TAB: Tab = { id: 'master-list', type: 'master-list', title: '상품마스터', icon: '🗂️', closable: true }
export const PRODUCTS_LIST_TAB: Tab = { id: 'products-list', type: 'products-list', title: '스크랩 Raw 확인', icon: '📥', closable: true }
