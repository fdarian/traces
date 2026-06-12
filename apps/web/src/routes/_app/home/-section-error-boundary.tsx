import React from 'react';

export class SectionErrorBoundary extends React.Component<
  {
    readonly children: React.ReactNode;
    readonly fallback: React.ReactNode;
  },
  { hasError: boolean }
> {
  constructor(props: {
    readonly children: React.ReactNode;
    readonly fallback: React.ReactNode;
  }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}
