import {expect,it} from 'vitest'
import {savedReviewCut} from './durableReviewLinks'

it('only selects a complete, bounded pair of saved review cuts',()=>{
  expect(savedReviewCut('?snapshotVersion=1&feedbackVersion=0')).toEqual({snapshotVersion:1,feedbackVersion:0})
  for(const query of ['?snapshotVersion=1','?snapshotVersion=0&feedbackVersion=0','?snapshotVersion=-1&feedbackVersion=2',
    '?snapshotVersion=1&feedbackVersion=NaN','?snapshotVersion=9007199254740992&feedbackVersion=2'])expect(savedReviewCut(query)).toBeNull()
})
