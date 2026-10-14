import { TopicsView, type TopicsViewProps } from './GuideTopics'

/** The Guide's How it works tab: eight topics (ticket 08, states 11 and 12). */
export const GuideHowItWorksTab = (props: Omit<TopicsViewProps, 'tab'>): JSX.Element => <TopicsView {...props} tab="how" />
